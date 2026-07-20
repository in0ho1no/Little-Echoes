// I2S再生（スピーカー）。docs/SPEC.md §5・§9・アプリ処理フロー5 に基づく。
//
// 設計方針: 他モジュールと同様、ハードウェア非依存のロジック（リングバッファ、
// 0x03 BODYのエフェクトID解釈、LE PCMバイト→サンプル変換）を切り出し、
// PlatformIO native環境でホスト側ユニットテスト可能にする。実際のI2S再生
// （M5Unified Speaker、PSRAM確保、DMA供給）は `#ifdef ARDUINO` の `SpeakerPlayer`
// が担い、再生音質・エフェクトID別演出との同期を実機確認する。
//
// 「受信部がリングバッファへ書き込み、再生タスクがリングバッファから読んで
// I2S DMAへ流す」構造とする（§9）。v1は全BODY受信後に一括書き込みしてから再生を
// 開始するが、再生タスクは常にリングバッファをチャンク単位で読み出すため、将来の
// ストリーミング化（受信しながら再生）は受信部の変更のみで済む。
#pragma once

#include <cstddef>
#include <cstdint>

#include "packet.h"

namespace audio_playback {

// 音声フォーマット（§4.1: Realtime API出力に合わせ24kHz/16bit/モノラル固定）
inline constexpr uint32_t kSampleRateHz = 24000;
inline constexpr uint8_t kBitsPerSample = 16;
inline constexpr uint8_t kChannels = 1;
inline constexpr size_t kBytesPerSample = static_cast<size_t>(kBitsPerSample) / 8 * kChannels;

// スピーカー音量（M5.Speaker.setVolume に渡す。0〜255）。未設定だと聞こえないことがあるため
// begin() で明示する。実機調整の経緯: 200=曇って小さい → 255=音割れ → 220（バランス点を探索中。
// まだ割れる/小さい場合はここを1箇所調整する）。
inline constexpr uint8_t kSpeakerVolume = 220;

// 最大応答長（§4.1: 30秒。24kHz/16bit/モノラルで約1.44MB）
inline constexpr uint32_t kMaxPlaybackMs = 30000;
// DMAキューまたは再生タスクが進行しない場合の待機上限。
inline constexpr uint32_t kPlaybackStallTimeoutMs = 1000;
inline constexpr size_t kMaxPlaybackSamples =
    static_cast<size_t>(kSampleRateHz) * kMaxPlaybackMs / 1000;  // 720,000
// PSRAMに確保する再生リングバッファのバイト数（720,000 * 2 = 1,440,000 ≈ 1.44MB）
inline constexpr size_t kPlaybackBufferBytes = kMaxPlaybackSamples * kBytesPerSample;

// 30秒ぶんのPCM＋エフェクトID1バイトが0x03パケットのSIZE上限2MBに収まること（§4.1）。
static_assert(kPlaybackBufferBytes + 1 <= transport::kMaxBodySize,
              "30秒応答がパケットSIZE上限2MBを超えている（docs/SPEC.md §4.1）");

constexpr bool hasElapsed(uint32_t startMs, uint32_t nowMs, uint32_t durationMs) {
    return static_cast<uint32_t>(nowMs - startMs) >= durationMs;
}

enum class PlaybackError {
    kNone,
    kBufferUnavailable,
    kInvalidBody,
    kInvalidState,
    kPlaybackTooLarge,
    kSpeakerStartFailed,
    kPlaybackStalled,
};

// エフェクトID（0x03 BODY先頭1バイト。§3.3）。
enum class EffectId : uint8_t {
    kNormal = 0x00,       // 通常応答（再生中は青の周期明滅。§5-4）
    kCelebration = 0x01,  // お祝い演出（レインボー等。§5-5）
};

// 0x03 BODY先頭バイトをEffectIdへ解釈する。未知値は通常応答へフォールバックする。
EffectId effectIdFromByte(uint8_t value);

// 0x03 BODY（先頭1バイト＝エフェクトID、以降PCM RAW）を分解した結果。
struct PlaybackBody {
    bool valid = false;
    EffectId effectId = EffectId::kNormal;
    const uint8_t* pcmBytes = nullptr;  // BODYの2バイト目以降（pcmByteCount==0ならnullptr）
    size_t pcmByteCount = 0;            // PCMバイト数
};

// 0x03 BODYを分解する。エフェクトID欠落、ポインター不整合、奇数長PCMはvalid=false。
PlaybackBody parsePlaybackBody(const uint8_t* body, size_t bodySize);

// int16サンプルのSPSCリングバッファ（ハードウェア非依存）。
//
// 受信部が write() で書き込み、再生タスクが read() で読み出す。バッファ（実機では
// PSRAM）は外部から注入する。単一の書き手・単一の読み手を前提とし、同一実行文脈から
// 使う（実機ではメインループが供給、DMAはM5.Speaker内部タスクが担うため、本クラスへの
// 並行アクセスは発生しない）。別タスク化する場合は呼び出し側で同期すること。
class PcmRingBuffer {
public:
    PcmRingBuffer(int16_t* buffer, size_t capacitySamples);

    // 実機のPSRAMバッファをbegin()時に束ねる。内容もクリアする。
    void setBuffer(int16_t* buffer, size_t capacitySamples);

    // 読み書き位置を先頭へ戻し、蓄積を空にする（応答切り替え・強制停止時に使う）。
    void clear();

    // 空き容量まで書き込み、実際に書き込めたサンプル数を返す（不足時は一部のみ）。
    // count が0、または samples が nullptr のときは何もせず0を返す。
    size_t write(const int16_t* samples, size_t count);

    // 最大 maxCount まで読み出し、実際に読み出したサンプル数を返す。
    // maxCount が0、または out が nullptr のときは何もせず0を返す。
    size_t read(int16_t* out, size_t maxCount);

    size_t capacity() const { return capacity_; }
    size_t available() const { return count_; }              // 読み出せるサンプル数
    size_t freeSpace() const { return capacity_ - count_; }  // 書き込める空き
    bool isEmpty() const { return count_ == 0; }
    bool isFull() const { return count_ == capacity_; }

private:
    int16_t* buffer_;
    size_t capacity_;
    size_t head_ = 0;   // 次に読み出す位置
    size_t tail_ = 0;   // 次に書き込む位置
    size_t count_ = 0;  // 蓄積サンプル数
};

// LE（リトルエンディアン）int16のPCMバイト列をサンプルへ変換してリングバッファへ
// 書き込む。奇数長・ポインター不整合は拒否し0を返す。実際に書き込めたサンプル数を返す。
// ホスト・ESP32ともLEだが、バイト合成を明示してエンディアン非依存にする。
size_t writePcmBytesLE(PcmRingBuffer& ring, const uint8_t* bytes, size_t byteCount);

#ifdef ARDUINO

// I2S実再生。リングバッファからチャンクを読み出してM5.SpeakerのDMAへ供給する。
// M5.Speaker.playRaw() は供給バッファを参照して再生するため、DMA完了まで生存する
// 固定チャンクプールを回して使う。チャンク長・プール段数は実機の再生音質確認時に調整する。
class SpeakerPlayer {
public:
    SpeakerPlayer() = default;

    // PSRAMリングバッファ（30秒ぶん）を確保し、M5.Speakerを24kHz/モノラルに設定する。
    // 確保に失敗した場合 false を返す。
    bool begin();

    // 0x03 BODYを受けて応答再生を開始する（v1: 全BODY受信後）。エフェクトIDを保持し、
    // PCMをリングバッファへ書き込んで再生を始める。マイクが動作中ならI2S共有のため停止する。
    // バッファ未確保なら false。
    bool startResponse(const uint8_t* body, size_t bodySize);

    // 将来の逐次受信でも再生部を変更しないためのストリーミング境界。
    bool startStream(EffectId effectId);
    // リングの空きまで受理し、書き込めたサンプル数を返す。呼び出し側は残りを再送する。
    size_t appendPcm(const uint8_t* pcmBytes, size_t pcmByteCount);
    // 入力完了を通知する。以後appendPcm()は拒否され、DMA完了後にloop()がfalseを返す。
    bool finishStream();

    // 再生中に毎ループ呼ぶ。リングバッファの残りをスピーカーへ供給する。
    // 再生継続中は true、リングが空でDMAも完了したら false（＝再生完了）を返す。
    bool loop();

    // 強制停止（トリプルクリック等。§6）。即時にDMAを止め、リングバッファをクリアする。
    void stop();

    bool isPlaying() const { return playing_; }
    EffectId effectId() const { return effectId_; }
    PlaybackError lastError() const { return error_; }

private:
    // DMA供給用チャンク長（約21ms @24kHz）と、参照再生中に上書きしない段数。実機で調整可能。
    static constexpr size_t kChunkSamples = 512;
    static constexpr size_t kChunkPoolSize = 3;
    // M5.Speakerの仮想チャンネル。
    static constexpr int kVirtualChannel = 0;

    bool pumpToSpeaker();
    void stopHardware();
    void fail(PlaybackError error);

    PcmRingBuffer ring_{nullptr, 0};
    int16_t* buffer_ = nullptr;  // PSRAM上の30秒リングバッファ
    int16_t chunk_[kChunkPoolSize][kChunkSamples] = {};
    size_t poolIdx_ = 0;
    EffectId effectId_ = EffectId::kNormal;
    bool playing_ = false;
    bool inputFinished_ = false;
    size_t pendingSamples_ = 0;
    size_t totalSamplesAccepted_ = 0;
    uint32_t lastProgressAtMs_ = 0;
    PlaybackError error_ = PlaybackError::kNone;
};

#endif  // ARDUINO

}  // namespace audio_playback
