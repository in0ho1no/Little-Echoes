// LED表現（NeoPixel、HEXボード37灯）。docs/SPEC.md §5, §2.2 に基づく。
//
// 設計方針: 「どの状態でどんなフレーム（37画素のRGB）を出すか」という演出ロジックを
// ハードウェア非依存の `LedAnimator` に切り出し、PlatformIO native環境でホスト側
// ユニットテスト可能にする。実際のNeoPixel駆動（Adafruit NeoPixel、RMT、輝度設定、
// show()）は `#ifdef ARDUINO` の `LedController` が担い、実機で目視確認する。
//
// 時刻は `TimeFunc`（std::function<uint32_t()>）注入で、packet.h / serial_link.h /
// button_input.h と同方式。経過は符号なし減算で32bitラップアラウンド安全。
#pragma once

#include <cstdint>
#include <functional>

#ifdef ARDUINO
#include <Adafruit_NeoPixel.h>
#endif

namespace led_controller {

// HEXボードのLED数（SK6812×37灯）。§2.2
inline constexpr uint16_t kLedCount = 37;
// データピン: G2を第一候補（反応しなければG1へ。ここ1箇所で変更可能）。§2.2, task0で実機確認済み
inline constexpr int16_t kLedDataPin = 2;
// 全体輝度の上限（§2.2 対策1: 30〜50%）。80/255 ≈ 31%。ハードウェア層で setBrightness に渡す
inline constexpr uint8_t kMaxBrightness = 80;
static_assert(kMaxBrightness >= 76 && kMaxBrightness <= 128,
              "最大輝度は255の30〜50%に収めること（docs/SPEC.md §2.2 対策1）");

// アニメーション周期・回数（すべて定数化。実測に応じて調整可能）
inline constexpr uint32_t kIdleBreathePeriodMs = 3000;   // 待機: 緑ホタル点滅（ゆっくり）
inline constexpr uint32_t kThinkingStepMs = 40;          // 考え中: 1画素進む間隔（37灯で約1.5秒/周）
inline constexpr uint16_t kThinkingCometLength = 3;      // 考え中: 回転コメットの長さ（点灯画素数）
inline constexpr uint32_t kPlayingBlinkPeriodMs = 1000;  // 再生中: 青の明滅周期（§5: 約1000ms）
inline constexpr uint32_t kCelebrationRotateStepMs = 20; // お祝い: レインボー回転（色相基点の進む間隔）
inline constexpr uint32_t kErrorBlinkPeriodMs = 200;     // エラー: 赤の速い点滅
inline constexpr uint16_t kErrorBlinkCount = 3;          // エラー: 3回（§5）
inline constexpr uint32_t kDiscardBlinkPeriodMs = 300;   // 録音破棄・単押し: 黄の短点滅
inline constexpr uint16_t kDiscardBlinkCount = 1;        // 1回（§5）
inline constexpr uint32_t kCancelBlinkPeriodMs = 300;    // キャンセル受理: マゼンタの短点滅（v1.3.1で青→変更）
inline constexpr uint16_t kCancelBlinkCount = 2;         // 2回（§5）
// NeoPixel転送の最短間隔。Adafruit NeoPixelのRMT送信完了待ちによるメインループ占有を
// 抑えつつ、最速のお祝い演出（20ms刻み）を表現できる50fpsとする。
inline constexpr uint32_t kLedRefreshIntervalMs = 20;

// LED演出の状態（§5の8状態）。
enum class LedStatus {
    kIdle,           // 1. 待機中: 緑ホタル点滅
    kRecording,      // 2. 録音中: 赤点灯
    kThinking,       // 3. 考え中: 円状の回転アニメーション
    kPlaying,        // 4. 応答・再生中: 青の周期明滅
    kCelebration,    // 5. お祝い演出: レインボー
    kError,          // 6. エラー: 赤の速い点滅3回（→待機は上位層）
    kDiscarded,      // 7. 録音破棄・単押し: 黄の短点滅1回（→待機は上位層）
    kCancelAccepted, // 8. キャンセル受理: マゼンタの短点滅2回（→待機は上位層。再生中の青と区別するためv1.3.1で青→変更）
};

struct Rgb {
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
};

// 演出フレーム計算（ハードウェア非依存）。
class LedAnimator {
public:
    using TimeFunc = std::function<uint32_t()>;

    explicit LedAnimator(TimeFunc timeFunc);

    // 演出状態を切り替える。アニメーションの基点時刻を現在時刻にリセットする。
    void setStatus(LedStatus status);

    LedStatus status() const { return status_; }

    // 現在時刻のフレームを out（kLedCount 要素）へ書き込む。
    void render(Rgb* out);

    // 状態変更直後または前回描画からkLedRefreshIntervalMs以上経過した場合だけ描画する。
    // 描画した場合true、更新間隔内で省略した場合false。
    bool renderIfDue(Rgb* out);

    // 一過性演出（エラー/録音破棄/キャンセル）が所定回数の点滅を終えたら true。
    // 非一過性（待機/録音/考え中/再生/お祝い）は常に false。上位層はこれを見て
    // 待機状態へ復帰する（§5の「→待機状態へ復帰」）。
    bool isTransientFinished() const;

private:
    void renderAt(Rgb* out, uint32_t now) const;

    TimeFunc timeFunc_;
    LedStatus status_ = LedStatus::kIdle;
    uint32_t startedMs_ = 0;
    uint32_t lastRenderedMs_ = 0;
    bool hasRendered_ = false;
    bool refreshPending_ = true;
};

#ifdef ARDUINO

// NeoPixel実駆動。演出ロジックは LedAnimator に委譲し、フレームをストリップへ流す。
class LedController {
public:
    explicit LedController(LedAnimator::TimeFunc timeFunc);

    // NeoPixel初期化＋輝度制限（§2.2 対策1）＋消灯。
    void begin();

    void setStatus(LedStatus status) { animator_.setStatus(status); }

    // 毎ループ呼ぶ。現在フレームを計算してストリップへ反映する。
    void loop();

    bool isTransientFinished() const { return animator_.isTransientFinished(); }

private:
    LedAnimator animator_;
    Adafruit_NeoPixel strip_;
};

#endif  // ARDUINO

}  // namespace led_controller
