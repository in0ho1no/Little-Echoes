// I2S録音の実装。ハードウェア非依存の蓄積・判定と、M5Unified Micによる実録音。
#include "audio_record.h"

#include <cstring>

#ifdef ARDUINO
#include <M5Unified.h>
#include <esp_heap_caps.h>
#endif

namespace audio_record {

AudioRecorder::AudioRecorder(int16_t* buffer, size_t capacitySamples)
    : buffer_(buffer), capacitySamples_(capacitySamples) {}

void AudioRecorder::setBuffer(int16_t* buffer, size_t capacitySamples) {
    buffer_ = buffer;
    capacitySamples_ = capacitySamples;
    count_ = 0;
    recording_ = false;
    error_ = RecorderError::kNone;
}

bool AudioRecorder::start() {
    count_ = 0;
    error_ = RecorderError::kNone;
    if (buffer_ == nullptr) {
        error_ = RecorderError::kBufferUnavailable;
        recording_ = false;
        return false;
    }
    if (capacitySamples_ < kMaxRecordingSamples) {
        error_ = RecorderError::kBufferTooSmall;
        recording_ = false;
        return false;
    }
    recording_ = true;
    return true;
}

bool AudioRecorder::append(const int16_t* samples, size_t count) {
    if (!recording_) {
        return false;
    }
    if (count > 0 && samples == nullptr) {
        abortWithError(RecorderError::kInvalidInput);
        return false;
    }
    // size==0 のときはポインター演算・memcpyを行わない。
    if (count > 0) {
        const size_t remaining = kMaxRecordingSamples - count_;
        const size_t toCopy = count < remaining ? count : remaining;
        if (toCopy > 0) {
            std::memcpy(buffer_ + count_, samples, toCopy * sizeof(int16_t));
            count_ += toCopy;
        }
    }
    if (count_ >= kMaxRecordingSamples) {
        recording_ = false;  // 30秒到達で強制終了（§4.1）
    }
    return recording_;
}

StopResult AudioRecorder::stop() {
    recording_ = false;
    if (error_ != RecorderError::kNone) {
        return StopResult::kError;
    }
    return count_ >= kMinRecordingSamples ? StopResult::kKept : StopResult::kDiscarded;
}

void AudioRecorder::abortWithError(RecorderError error) {
    recording_ = false;
    error_ = error;
}

#ifdef ARDUINO

bool MicRecorder::begin() {
    if (buffer_ == nullptr) {
        buffer_ = static_cast<int16_t*>(heap_caps_malloc(kRecordBufferBytes, MALLOC_CAP_SPIRAM));
        if (buffer_ == nullptr) {
            return false;
        }
    }
    recorder_.setBuffer(buffer_, kMaxRecordingSamples);
    auto cfg = M5.Mic.config();
    cfg.sample_rate = kSampleRateHz;
    cfg.stereo = false;
    cfg.magnification = kMicMagnification;  // 録音音量を上げる（既定16では小さかった）
    M5.Mic.config(cfg);
    return true;
}

bool MicRecorder::startRecording() {
    if (!recorder_.start()) {
        return false;
    }
    // 録音と再生でI2Sを共有するため、スピーカーが有効なら止める（§9のI2O排他）。
    if (M5.Speaker.isEnabled()) {
        M5.Speaker.end();
    }
    if (!M5.Mic.begin()) {
        recorder_.abortWithError(RecorderError::kMicStartFailed);
        return false;
    }
    activeIdx_ = 0;
    pendingChunk_ = false;
    startedAtMs_ = millis();
    // 最初のチャンクを予約する。
    if (!M5.Mic.record(chunk_[activeIdx_], kChunkSamples, kSampleRateHz)) {
        M5.Mic.end();
        recorder_.abortWithError(RecorderError::kCaptureStartFailed);
        return false;
    }
    pendingChunk_ = true;
    return true;
}

bool MicRecorder::loop() {
    if (!recorder_.isRecording()) {
        return false;
    }
    if (hasElapsed(startedAtMs_, millis(), kMaxRecordingMs)) {
        // サンプルが届かない場合も、仕様上の30秒でマイクを確実に停止する。
        pendingChunk_ = false;
        M5.Mic.end();
        recorder_.stop();
        return false;
    }
    // 予約したチャンクのDMAが完了していれば（キューが空になっていれば）取り込む。
    if (pendingChunk_ && M5.Mic.isRecording() == 0) {
        recorder_.append(chunk_[activeIdx_], kChunkSamples);
        pendingChunk_ = false;
        if (!recorder_.isRecording()) {
            M5.Mic.end();
            return false;  // 30秒到達で自動停止
        }
    }
    // 次のチャンクを別バッファへ予約する（DMA中に取り込みバッファを汚さない）。
    if (!pendingChunk_) {
        activeIdx_ ^= 1;
        if (!M5.Mic.record(chunk_[activeIdx_], kChunkSamples, kSampleRateHz)) {
            M5.Mic.end();
            recorder_.abortWithError(RecorderError::kCaptureStartFailed);
            return false;
        }
        pendingChunk_ = true;
    }
    return recorder_.isRecording();
}

StopResult MicRecorder::stopRecording() {
    // 予約済みチャンクのDMA完了を待って末尾まで取り込む（取りこぼし防止。待ちは高々1チャンク）。
    if (pendingChunk_) {
        const uint32_t waitStartedAtMs = millis();
        while (M5.Mic.isRecording() != 0) {
            if (hasElapsed(waitStartedAtMs, millis(), kDmaStopTimeoutMs)) {
                M5.Mic.end();
                pendingChunk_ = false;
                recorder_.abortWithError(RecorderError::kCaptureTimeout);
                return recorder_.stop();
            }
            delay(1);
        }
        recorder_.append(chunk_[activeIdx_], kChunkSamples);
        pendingChunk_ = false;
    }
    M5.Mic.end();
    return recorder_.stop();
}

#endif  // ARDUINO

}  // namespace audio_record
