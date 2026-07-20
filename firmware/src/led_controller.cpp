// LED表現の実装。演出フレーム計算（ハードウェア非依存）とNeoPixel駆動。
#include "led_controller.h"

#include <utility>

namespace led_controller {

namespace {

void fillAll(Rgb* out, const Rgb& color) {
    for (uint16_t i = 0; i < kLedCount; ++i) {
        out[i] = color;
    }
}

void clearAll(Rgb* out) {
    fillAll(out, Rgb{});
}

// §2.2の電源対策として、全37灯を同時点灯せず交互配置の最大19灯だけを点灯する。
void fillAlternating(Rgb* out, const Rgb& color) {
    for (uint16_t i = 0; i < kLedCount; i += 2) {
        out[i] = color;
    }
}

// 0→255→0 の三角波。ホタル点滅・青明滅の輝度に使う。
uint8_t triangle(uint32_t elapsed, uint32_t period) {
    const uint32_t phase = elapsed % period;
    const uint32_t half = period / 2;
    const uint32_t up = phase < half ? phase : (period - phase);
    return static_cast<uint8_t>(up * 255 / half);
}

// 点滅がcount回終わるまでの「点灯中か」。周期前半を点灯とする。
bool blinkLit(uint32_t elapsed, uint32_t period, uint16_t count) {
    if (elapsed >= period * count) {
        return false;
    }
    return (elapsed % period) < (period / 2);
}

bool blinkFinished(uint32_t elapsed, uint32_t period, uint16_t count) {
    return elapsed >= period * count;
}

// 彩度・明度最大のHSV→RGB（h: 0〜359度）。必ずいずれか1チャンネルが0になるため
// 白（全チャンネル高）にはならない（§2.2 対策2に沿う）。
Rgb hsvToRgb(uint16_t h) {
    const uint16_t region = h / 60;
    const uint16_t rem = h % 60;
    const uint8_t v = 255;
    const auto q = static_cast<uint8_t>(v * (60 - rem) / 60);
    const auto t = static_cast<uint8_t>(v * rem / 60);
    switch (region) {
        case 0:  return Rgb{v, t, 0};
        case 1:  return Rgb{q, v, 0};
        case 2:  return Rgb{0, v, t};
        case 3:  return Rgb{0, q, v};
        case 4:  return Rgb{t, 0, v};
        default: return Rgb{v, 0, q};  // region 5
    }
}

}  // namespace

LedAnimator::LedAnimator(TimeFunc timeFunc) : timeFunc_(std::move(timeFunc)) {
    startedMs_ = timeFunc_();
}

void LedAnimator::setStatus(LedStatus status) {
    status_ = status;
    startedMs_ = timeFunc_();
    refreshPending_ = true;
}

void LedAnimator::render(Rgb* out) {
    renderAt(out, timeFunc_());
}

bool LedAnimator::renderIfDue(Rgb* out) {
    const uint32_t now = timeFunc_();
    if (!refreshPending_ && hasRendered_ && now - lastRenderedMs_ < kLedRefreshIntervalMs) {
        return false;
    }
    renderAt(out, now);
    lastRenderedMs_ = now;
    hasRendered_ = true;
    refreshPending_ = false;
    return true;
}

void LedAnimator::renderAt(Rgb* out, uint32_t now) const {
    const uint32_t elapsed = now - startedMs_;
    clearAll(out);

    switch (status_) {
        case LedStatus::kIdle: {
            const uint8_t g = triangle(elapsed, kIdleBreathePeriodMs);
            fillAlternating(out, Rgb{0, g, 0});
            break;
        }
        case LedStatus::kRecording:
            fillAlternating(out, Rgb{255, 0, 0});
            break;
        case LedStatus::kThinking: {
            // 数画素のコメットが円状に回転する。点灯は一部のみ（§2.2 対策2）。
            const uint16_t head = static_cast<uint16_t>((elapsed / kThinkingStepMs) % kLedCount);
            for (uint16_t i = 0; i < kThinkingCometLength; ++i) {
                const uint16_t idx = static_cast<uint16_t>((head + kLedCount - i) % kLedCount);
                const uint8_t scale = static_cast<uint8_t>(255u >> i);  // 255,127,63,...
                out[idx] = Rgb{0,
                               static_cast<uint8_t>(100u * scale / 255u),
                               static_cast<uint8_t>(255u * scale / 255u)};
            }
            break;
        }
        case LedStatus::kPlaying: {
            const uint8_t b = triangle(elapsed, kPlayingBlinkPeriodMs);
            fillAlternating(out, Rgb{0, 0, b});
            break;
        }
        case LedStatus::kCelebration: {
            const uint16_t base = static_cast<uint16_t>((elapsed / kCelebrationRotateStepMs) % 360);
            for (uint16_t i = 0; i < kLedCount; i += 2) {
                const uint16_t h = static_cast<uint16_t>((base + static_cast<uint32_t>(i) * 360 / kLedCount) % 360);
                out[i] = hsvToRgb(h);
            }
            break;
        }
        case LedStatus::kError:
            if (blinkLit(elapsed, kErrorBlinkPeriodMs, kErrorBlinkCount)) {
                fillAlternating(out, Rgb{255, 0, 0});
            }
            break;
        case LedStatus::kDiscarded:
            if (blinkLit(elapsed, kDiscardBlinkPeriodMs, kDiscardBlinkCount)) {
                fillAlternating(out, Rgb{255, 255, 0});
            }
            break;
        case LedStatus::kCancelAccepted:
            // マゼンタ（§5-8、v1.3.1で青から変更）: 再生中の青明滅の最中にトリプルクリックしても
            // 受理点滅が区別できるようにする。黄は録音破棄（§5-7）と紛れるため使わない。
            if (blinkLit(elapsed, kCancelBlinkPeriodMs, kCancelBlinkCount)) {
                fillAlternating(out, Rgb{255, 0, 255});
            }
            break;
    }
}

bool LedAnimator::isTransientFinished() const {
    const uint32_t elapsed = timeFunc_() - startedMs_;
    switch (status_) {
        case LedStatus::kError:
            return blinkFinished(elapsed, kErrorBlinkPeriodMs, kErrorBlinkCount);
        case LedStatus::kDiscarded:
            return blinkFinished(elapsed, kDiscardBlinkPeriodMs, kDiscardBlinkCount);
        case LedStatus::kCancelAccepted:
            return blinkFinished(elapsed, kCancelBlinkPeriodMs, kCancelBlinkCount);
        default:
            return false;
    }
}

#ifdef ARDUINO

LedController::LedController(LedAnimator::TimeFunc timeFunc)
    : animator_(std::move(timeFunc)), strip_(kLedCount, kLedDataPin, NEO_GRB + NEO_KHZ800) {}

void LedController::begin() {
    strip_.begin();
    strip_.setBrightness(kMaxBrightness);  // §2.2 対策1
    strip_.clear();
    strip_.show();
}

void LedController::loop() {
    Rgb frame[kLedCount];
    if (!animator_.renderIfDue(frame)) {
        return;
    }
    for (uint16_t i = 0; i < kLedCount; ++i) {
        strip_.setPixelColor(i, frame[i].r, frame[i].g, frame[i].b);
    }
    strip_.show();
}

#endif  // ARDUINO

}  // namespace led_controller
