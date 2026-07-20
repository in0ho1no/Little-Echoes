// I2S再生の実装。ハードウェア非依存のリングバッファ・BODY解釈と、M5Unified Speakerによる実再生。
#include "audio_playback.h"

#include <cstring>

#ifdef ARDUINO
#include <M5Unified.h>
#include <esp_heap_caps.h>
#endif

namespace audio_playback {

EffectId effectIdFromByte(uint8_t value) {
    switch (value) {
        case static_cast<uint8_t>(EffectId::kCelebration):
            return EffectId::kCelebration;
        case static_cast<uint8_t>(EffectId::kNormal):
        default:
            return EffectId::kNormal;  // 未知IDは通常応答へフォールバック
    }
}

PlaybackBody parsePlaybackBody(const uint8_t* body, size_t bodySize) {
    PlaybackBody result;
    if (body == nullptr || bodySize == 0) {
        return result;
    }
    result.effectId = effectIdFromByte(body[0]);
    const size_t pcmBytes = bodySize - 1;
    if ((pcmBytes % kBytesPerSample) != 0) {
        return result;
    }
    if (pcmBytes > 0) {
        result.pcmBytes = body + 1;
        result.pcmByteCount = pcmBytes;
    }
    result.valid = true;
    return result;
}

PcmRingBuffer::PcmRingBuffer(int16_t* buffer, size_t capacitySamples)
    : buffer_(buffer), capacity_(capacitySamples) {}

void PcmRingBuffer::setBuffer(int16_t* buffer, size_t capacitySamples) {
    buffer_ = buffer;
    capacity_ = capacitySamples;
    head_ = 0;
    tail_ = 0;
    count_ = 0;
}

void PcmRingBuffer::clear() {
    head_ = 0;
    tail_ = 0;
    count_ = 0;
}

size_t PcmRingBuffer::write(const int16_t* samples, size_t count) {
    if (buffer_ == nullptr || samples == nullptr || count == 0) {
        return 0;
    }
    const size_t space = capacity_ - count_;
    const size_t toWrite = count < space ? count : space;
    if (toWrite == 0) {
        return 0;
    }
    // 末尾までの連続領域と、先頭へ回り込む領域に分けてコピーする。
    const size_t firstLen = toWrite < capacity_ - tail_ ? toWrite : capacity_ - tail_;
    std::memcpy(buffer_ + tail_, samples, firstLen * sizeof(int16_t));
    const size_t secondLen = toWrite - firstLen;
    if (secondLen > 0) {
        std::memcpy(buffer_, samples + firstLen, secondLen * sizeof(int16_t));
    }
    tail_ = (tail_ + toWrite) % capacity_;
    count_ += toWrite;
    return toWrite;
}

size_t PcmRingBuffer::read(int16_t* out, size_t maxCount) {
    if (buffer_ == nullptr || out == nullptr || maxCount == 0) {
        return 0;
    }
    const size_t toRead = count_ < maxCount ? count_ : maxCount;
    if (toRead == 0) {
        return 0;
    }
    const size_t firstLen = toRead < capacity_ - head_ ? toRead : capacity_ - head_;
    std::memcpy(out, buffer_ + head_, firstLen * sizeof(int16_t));
    const size_t secondLen = toRead - firstLen;
    if (secondLen > 0) {
        std::memcpy(out + firstLen, buffer_, secondLen * sizeof(int16_t));
    }
    head_ = (head_ + toRead) % capacity_;
    count_ -= toRead;
    return toRead;
}

size_t writePcmBytesLE(PcmRingBuffer& ring, const uint8_t* bytes, size_t byteCount) {
    if (byteCount == 0) {
        return 0;
    }
    if (bytes == nullptr || (byteCount % kBytesPerSample) != 0) {
        return 0;
    }
    const size_t sampleCount = byteCount / kBytesPerSample;
    int16_t tmp[256];
    size_t written = 0;
    size_t i = 0;
    while (i < sampleCount) {
        const size_t n = (sampleCount - i) < 256 ? (sampleCount - i) : 256;
        for (size_t k = 0; k < n; ++k) {
            const size_t base = (i + k) * 2;
            const uint16_t lo = bytes[base];
            const uint16_t hi = bytes[base + 1];
            tmp[k] = static_cast<int16_t>(static_cast<uint16_t>(lo | (hi << 8)));
        }
        const size_t w = ring.write(tmp, n);
        written += w;
        i += n;
        if (w < n) {
            break;  // リングバッファが満杯
        }
    }
    return written;
}

#ifdef ARDUINO

bool SpeakerPlayer::begin() {
    if (buffer_ == nullptr) {
        buffer_ = static_cast<int16_t*>(heap_caps_malloc(kPlaybackBufferBytes, MALLOC_CAP_SPIRAM));
        if (buffer_ == nullptr) {
            error_ = PlaybackError::kBufferUnavailable;
            return false;
        }
    }
    ring_.setBuffer(buffer_, kMaxPlaybackSamples);
    auto cfg = M5.Speaker.config();
    cfg.sample_rate = kSampleRateHz;
    M5.Speaker.config(cfg);
    // 音量を明示設定する（未設定だと聞こえない/小さいことがある。0〜255、実測に応じて調整）。
    M5.Speaker.setVolume(kSpeakerVolume);
    error_ = PlaybackError::kNone;
    return true;
}

bool SpeakerPlayer::startResponse(const uint8_t* body, size_t bodySize) {
    const PlaybackBody parsed = parsePlaybackBody(body, bodySize);
    if (!parsed.valid) {
        fail(PlaybackError::kInvalidBody);
        return false;
    }
    if (!startStream(parsed.effectId)) {
        return false;
    }
    const size_t expectedSamples = parsed.pcmByteCount / kBytesPerSample;
    if (appendPcm(parsed.pcmBytes, parsed.pcmByteCount) != expectedSamples) {
        if (lastError() == PlaybackError::kNone) {
            fail(PlaybackError::kPlaybackTooLarge);
        }
        return false;
    }
    if (!finishStream()) {
        return false;
    }
    pumpToSpeaker();
    return error_ == PlaybackError::kNone;
}

bool SpeakerPlayer::startStream(EffectId effectId) {
    if (buffer_ == nullptr) {
        error_ = PlaybackError::kBufferUnavailable;
        return false;
    }
    // 前回のDMAが残っている場合はチャンクプール再利用前に完全停止する。
    if (playing_ || M5.Speaker.isPlaying()) {
        M5.Speaker.end();
    }
    ring_.clear();
    poolIdx_ = 0;
    pendingSamples_ = 0;
    totalSamplesAccepted_ = 0;
    inputFinished_ = false;
    effectId_ = effectId;
    error_ = PlaybackError::kNone;
    // 録音と再生でI2Sを共有するため、マイクが有効なら止める（§9のI2S排他）。
    if (M5.Mic.isEnabled()) {
        M5.Mic.end();
    }
    if (!M5.Speaker.begin()) {
        M5.Speaker.end();
        fail(PlaybackError::kSpeakerStartFailed);
        return false;
    }
    playing_ = true;
    lastProgressAtMs_ = millis();
    return true;
}

size_t SpeakerPlayer::appendPcm(const uint8_t* pcmBytes, size_t pcmByteCount) {
    if (!playing_ || inputFinished_) {
        fail(PlaybackError::kInvalidState);
        return 0;
    }
    if ((pcmByteCount > 0 && pcmBytes == nullptr) || (pcmByteCount % kBytesPerSample) != 0) {
        fail(PlaybackError::kInvalidBody);
        return 0;
    }
    const size_t requestedSamples = pcmByteCount / kBytesPerSample;
    if (requestedSamples > kMaxPlaybackSamples - totalSamplesAccepted_) {
        fail(PlaybackError::kPlaybackTooLarge);
        return 0;
    }
    const size_t written = writePcmBytesLE(ring_, pcmBytes, pcmByteCount);
    totalSamplesAccepted_ += written;
    return written;
}

bool SpeakerPlayer::finishStream() {
    if (!playing_ || inputFinished_) {
        fail(PlaybackError::kInvalidState);
        return false;
    }
    inputFinished_ = true;
    return true;
}

bool SpeakerPlayer::pumpToSpeaker() {
    bool progressed = false;
    // M5.Speakerのキューに空きがある限り、リングバッファからチャンクを流し込む。
    // 参照再生のため、DMA完了まで生存する固定プールを順に使う。プール段数(3)は
    // スピーカーの同時保持数(最大2)より多く、再利用するチャンクは必ず再生完了済み。
    while ((pendingSamples_ > 0 || !ring_.isEmpty()) && M5.Speaker.isPlaying(kVirtualChannel) < 2) {
        int16_t* dst = chunk_[poolIdx_];
        if (pendingSamples_ == 0) {
            pendingSamples_ = ring_.read(dst, kChunkSamples);
            if (pendingSamples_ == 0) {
                break;
            }
        }
        if (!M5.Speaker.isRunning() ||
            !M5.Speaker.playRaw(dst, pendingSamples_, kSampleRateHz, false, 1, kVirtualChannel)) {
            break;  // 未投入チャンクを保持し、次ループで同じデータを再試行する。
        }
        pendingSamples_ = 0;
        poolIdx_ = (poolIdx_ + 1) % kChunkPoolSize;
        progressed = true;
    }
    if (progressed) {
        lastProgressAtMs_ = millis();
    }
    return progressed;
}

bool SpeakerPlayer::loop() {
    if (!playing_) {
        return false;
    }
    pumpToSpeaker();
    const bool hasPendingWork = pendingSamples_ > 0 || !ring_.isEmpty() ||
                                (inputFinished_ && M5.Speaker.isPlaying(kVirtualChannel) != 0);
    if (hasPendingWork && hasElapsed(lastProgressAtMs_, millis(), kPlaybackStallTimeoutMs)) {
        fail(PlaybackError::kPlaybackStalled);
        return false;
    }
    // リングバッファが空で、スピーカーのDMAも全て完了したら再生完了。
    if (inputFinished_ && pendingSamples_ == 0 && ring_.isEmpty() &&
        M5.Speaker.isPlaying(kVirtualChannel) == 0) {
        playing_ = false;
        return false;
    }
    return true;
}

void SpeakerPlayer::stop() {
    stopHardware();
    error_ = PlaybackError::kNone;
}

void SpeakerPlayer::stopHardware() {
    M5.Speaker.stop();  // 全チャンネル即時停止
    ring_.clear();
    poolIdx_ = 0;
    pendingSamples_ = 0;
    totalSamplesAccepted_ = 0;
    inputFinished_ = true;
    playing_ = false;
}

void SpeakerPlayer::fail(PlaybackError error) {
    stopHardware();
    error_ = error;
}

#endif  // ARDUINO

}  // namespace audio_playback
