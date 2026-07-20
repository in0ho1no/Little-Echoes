// I2S録音（マイク→PSRAMバッファ）。docs/SPEC.md §4.1 に基づく。
//
// 設計方針: 他モジュール（led_controller等）と同様、ハードウェア非依存の蓄積・
// 判定ロジックを `AudioRecorder` に切り出し、PlatformIO native環境でホスト側
// ユニットテスト可能にする。実際のI2S録音（M5Unified Mic、PSRAM確保、DMA取り込み）は
// `#ifdef ARDUINO` の `MicRecorder` が担い、録音データをPC側でWAV化して音質確認する。
//
// 録音データ量はサンプル数で管理し、実機の録音時間上限は単調増加タイマーでも監視する。
// DMA停止や取り込み失敗時にも、物理的な録音を30秒以内に終了させるためである。
#pragma once

#include <cstddef>
#include <cstdint>

#include "button_input.h"
#include "packet.h"

namespace audio_record {

// 音声フォーマット（§4.1: Realtime API入力に合わせ24kHz/16bit/モノラル固定）
inline constexpr uint32_t kSampleRateHz = 24000;
inline constexpr uint8_t kBitsPerSample = 16;
inline constexpr uint8_t kChannels = 1;
inline constexpr size_t kBytesPerSample = static_cast<size_t>(kBitsPerSample) / 8 * kChannels;

// 最短録音長（§4.1: 1.5秒未満は誤操作・チャタリングとして破棄）。
// button_input の長押し境界と同一値（下の static_assert で一致を担保）。
inline constexpr uint32_t kMinRecordingMs = 1500;
// 最大録音長（§4.1: 30秒到達で強制終了しその時点までを送信）。
inline constexpr uint32_t kMaxRecordingMs = 30000;
// 停止時に処理中のDMAチャンクを待つ上限。通常の1チャンク（約21ms）に余裕を持たせる。
inline constexpr uint32_t kDmaStopTimeoutMs = 100;

// マイク入力ゲイン（M5Unified mic_config_t の magnification。サンプルを整数倍する）。既定16では
// 録音音量が小さかったため引き上げる。大きすぎると大音量で歪む/クリップするため実機で調整可能。
inline constexpr uint8_t kMicMagnification = 32;

// ミリ秒→サンプル数（24kHzなので 1ms = 24サンプル。割り切れる）
inline constexpr size_t kMinRecordingSamples =
    static_cast<size_t>(kSampleRateHz) * kMinRecordingMs / 1000;  // 36,000
inline constexpr size_t kMaxRecordingSamples =
    static_cast<size_t>(kSampleRateHz) * kMaxRecordingMs / 1000;  // 720,000
// PSRAMに確保する録音バッファのバイト数（720,000 * 2 = 1,440,000 ≈ 1.44MB）
inline constexpr size_t kRecordBufferBytes = kMaxRecordingSamples * kBytesPerSample;

// 最短録音長は §6 のボタン長押し境界と同一値でなければならない（§4.1・task_マイコン.md）。
static_assert(kMinRecordingMs == button_input::kLongPressMs,
              "最短録音長は button_input::kLongPressMs と一致させること（docs/SPEC.md §4.1/§6）");
// 30秒ぶんの録音BODYがパケットSIZE上限2MBに収まること（§4.1）。
static_assert(kRecordBufferBytes <= transport::kMaxBodySize,
              "30秒録音がパケットSIZE上限2MBを超えている（docs/SPEC.md §4.1）");

// uint32_tタイマーの周回を許容した経過時間判定。durationは2^31ms未満を前提とする。
constexpr bool hasElapsed(uint32_t startMs, uint32_t nowMs, uint32_t durationMs) {
    return static_cast<uint32_t>(nowMs - startMs) >= durationMs;
}

enum class RecorderError {
    kNone,
    kBufferUnavailable,
    kBufferTooSmall,
    kInvalidInput,
    kMicStartFailed,
    kCaptureStartFailed,
    kCaptureTimeout,
};

// 録音停止時の判定結果。
enum class StopResult {
    kKept,       // 最短録音長以上。0x01で送信する対象
    kDiscarded,  // 最短録音長未満。破棄して待機へ戻る（黄点滅は上位層）
    kError,      // 録音処理に失敗。lastError()で原因を確認する
};

// 録音バッファへの蓄積と最短/最長判定（ハードウェア非依存）。
//
// バッファ（実機ではPSRAM）は外部から注入する。容量は kMaxRecordingSamples 以上を
// 前提とし、蓄積が容量に達した時点で自動停止する（＝30秒到達での強制終了、§4.1）。
class AudioRecorder {
public:
    // 実機では begin() でPSRAMを確保してから setBuffer() で束ねる（nullptr/0で構築可）。
    AudioRecorder(int16_t* buffer, size_t capacitySamples);

    // 実機のPSRAMバッファをbegin()時に束ねる。蓄積状態もリセットする。
    void setBuffer(int16_t* buffer, size_t capacitySamples);

    // 録音を開始する。バッファ未束縛なら false を返し、録音状態へ遷移しない。
    bool start();

    // マイクから読んだPCMサンプルを追記する。count が残容量を超える場合は残容量ぶんだけ
    // 取り込み、容量到達（＝30秒）で自動停止する。count が0のときは samples を参照しない。
    // 戻り値: 追記後も録音継続中なら true、（容量到達で）停止したら false。
    bool append(const int16_t* samples, size_t count);

    // 録音を停止し、最短録音長との比較で送信/破棄を判定する（§4.1）。
    StopResult stop();

    // ハードウェア層を含む回復不能エラーで録音を中断する。
    void abortWithError(RecorderError error);

    bool isRecording() const { return recording_; }
    RecorderError lastError() const { return error_; }
    // 蓄積が容量（30秒）に達しているか。
    bool isFull() const { return count_ >= kMaxRecordingSamples; }

    // 蓄積済みPCMの先頭。sizeSamples()が0のとき参照しないこと。
    const int16_t* data() const { return buffer_; }
    size_t sizeSamples() const { return count_; }
    size_t sizeBytes() const { return count_ * kBytesPerSample; }
    // 蓄積サンプル数から算出した録音長（ミリ秒）。
    uint32_t durationMs() const {
        return static_cast<uint32_t>(static_cast<uint64_t>(count_) * 1000 / kSampleRateHz);
    }

private:
    int16_t* buffer_;
    size_t capacitySamples_;
    size_t count_ = 0;
    bool recording_ = false;
    RecorderError error_ = RecorderError::kNone;
};

#ifdef ARDUINO

// I2S実録音。M5Unified Micでマイクから読み取り、AudioRecorderへ蓄積する。
// M5.Mic.record() は非同期（DMAキュー方式）のため、DMA完了タイミングとチャンク長は
// 実機での録音音質確認（本タスクの完了条件）時に調整する。
class MicRecorder {
public:
    MicRecorder() = default;

    // PSRAMバッファ（30秒ぶん）を確保し、M5.Micを24kHz/モノラルに設定する。
    // 確保に失敗した場合 false を返す。
    bool begin();

    // 録音を開始する（スピーカーが有効ならI2S共有のため停止する）。
    // マイク初期化または最初のDMA予約に失敗した場合 false を返す。
    bool startRecording();

    // 録音中に毎ループ呼ぶ。完了したチャンクを取り込み、次チャンクを予約する。
    // 継続中は true、30秒到達で自動停止したら false を返す。
    bool loop();

    // 録音を停止する。予約済みチャンクのDMA完了を待って末尾まで取り込み、判定を返す。
    StopResult stopRecording();

    bool isRecording() const { return recorder_.isRecording(); }
    const int16_t* data() const { return recorder_.data(); }
    size_t sizeBytes() const { return recorder_.sizeBytes(); }
    uint32_t durationMs() const { return recorder_.durationMs(); }
    RecorderError lastError() const { return recorder_.lastError(); }

private:
    // DMA取り込み用チャンク長（約21ms @24kHz）。実機で調整可能。
    static constexpr size_t kChunkSamples = 512;

    AudioRecorder recorder_{nullptr, 0};
    int16_t* buffer_ = nullptr;  // PSRAM上の30秒バッファ
    int16_t chunk_[2][kChunkSamples] = {};
    uint8_t activeIdx_ = 0;
    bool pendingChunk_ = false;
    uint32_t startedAtMs_ = 0;
};

#endif  // ARDUINO

}  // namespace audio_record
