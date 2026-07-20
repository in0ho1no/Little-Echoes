// led_controller::LedAnimator のホスト側ユニットテスト（§5の8状態演出と§2.2の電源対策）。
// 実際のNeoPixel駆動・輝度・アニメーションの目視は実機確認の対象。ここでは
// フレーム計算ロジック（色・パターン・一過性演出の終了判定・白全灯回避）を検証する。
#include <unity.h>

#include <cstdint>

#include "led_controller.h"

using led_controller::kCancelBlinkCount;
using led_controller::kCancelBlinkPeriodMs;
using led_controller::kDiscardBlinkCount;
using led_controller::kDiscardBlinkPeriodMs;
using led_controller::kErrorBlinkCount;
using led_controller::kErrorBlinkPeriodMs;
using led_controller::kIdleBreathePeriodMs;
using led_controller::kLedCount;
using led_controller::kLedRefreshIntervalMs;
using led_controller::kPlayingBlinkPeriodMs;
using led_controller::kThinkingStepMs;
using led_controller::LedAnimator;
using led_controller::LedStatus;
using led_controller::Rgb;

namespace {

uint32_t g_now = 0;

uint32_t fakeClock() {
    return g_now;
}

// フレーム内で点灯（非黒）している画素数。
uint16_t litCount(const Rgb* frame) {
    uint16_t n = 0;
    for (uint16_t i = 0; i < kLedCount; ++i) {
        if (frame[i].r != 0 || frame[i].g != 0 || frame[i].b != 0) {
            ++n;
        }
    }
    return n;
}

}  // namespace

void setUp() {
    g_now = 0;
}

void tearDown() {}

// ---- §2.2 対策2: 全状態で常に一部のLEDのみ点灯する ----

// 全8状態・全経過位相で、37灯すべてを同時点灯しないこと
static void test_all_statuses_limit_simultaneous_lit_pixels() {
    const LedStatus statuses[] = {
        LedStatus::kIdle,        LedStatus::kRecording,     LedStatus::kThinking,
        LedStatus::kPlaying,     LedStatus::kCelebration,   LedStatus::kError,
        LedStatus::kDiscarded,   LedStatus::kCancelAccepted,
    };
    for (const LedStatus s : statuses) {
        LedAnimator anim(fakeClock);
        anim.setStatus(s);
        for (uint32_t t = 0; t <= 4000; t += 37) {
            g_now = t;
            Rgb frame[kLedCount];
            anim.render(frame);
            TEST_ASSERT_TRUE(litCount(frame) < kLedCount);
        }
    }
}

// ---- 1. 待機中: 緑ホタル点滅 ----

// 緑チャンネルのみ使い（赤=青=0）、時間で明るさが変化すること
static void test_idle_is_green_and_breathes() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kIdle);

    g_now = kIdleBreathePeriodMs / 2;  // 三角波のピーク付近
    Rgb peak[kLedCount];
    anim.render(peak);
    TEST_ASSERT_EQUAL_UINT8(0, peak[0].r);
    TEST_ASSERT_EQUAL_UINT8(0, peak[0].b);
    TEST_ASSERT_TRUE(peak[0].g > 0);

    g_now = 0;  // 三角波の谷（消灯）
    Rgb valley[kLedCount];
    anim.render(valley);
    TEST_ASSERT_TRUE(valley[0].g < peak[0].g);  // 明るさが変化している
}

// ---- 2. 録音中: 赤点灯 ----

// 交互配置の画素が一定の赤（時間によらず一定）であること
static void test_recording_is_solid_red() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kRecording);
    for (uint32_t t : {0u, 500u, 5000u}) {
        g_now = t;
        Rgb frame[kLedCount];
        anim.render(frame);
        TEST_ASSERT_EQUAL_UINT16((kLedCount + 1) / 2, litCount(frame));
        TEST_ASSERT_EQUAL_UINT8(255, frame[0].r);
        TEST_ASSERT_EQUAL_UINT8(0, frame[0].g);
        TEST_ASSERT_EQUAL_UINT8(0, frame[0].b);
    }
}

// ---- 3. 考え中: 円状の回転 ----

// 点灯は一部の画素のみ（全灯しない）で、時間経過で点灯位置が移動すること
static void test_thinking_lights_subset_and_rotates() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kThinking);

    g_now = 0;
    Rgb f0[kLedCount];
    anim.render(f0);
    const uint16_t lit0 = litCount(f0);
    TEST_ASSERT_TRUE(lit0 > 0);
    TEST_ASSERT_TRUE(lit0 < kLedCount);  // 一部のみ点灯（§2.2 対策2）

    // 1画素分以上進めると点灯パターンが変わること
    g_now = kThinkingStepMs * 5;
    Rgb f1[kLedCount];
    anim.render(f1);
    bool differs = false;
    for (uint16_t i = 0; i < kLedCount; ++i) {
        if (f0[i].r != f1[i].r || f0[i].g != f1[i].g || f0[i].b != f1[i].b) {
            differs = true;
            break;
        }
    }
    TEST_ASSERT_TRUE(differs);
}

// ---- 4. 応答・再生中: 青の明滅 ----

// 青チャンネルのみ使い（赤=緑=0）、時間で明るさが変化すること
static void test_playing_is_blue_and_blinks() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kPlaying);

    g_now = kPlayingBlinkPeriodMs / 2;  // ピーク
    Rgb peak[kLedCount];
    anim.render(peak);
    TEST_ASSERT_EQUAL_UINT8(0, peak[0].r);
    TEST_ASSERT_EQUAL_UINT8(0, peak[0].g);
    TEST_ASSERT_TRUE(peak[0].b > 0);

    g_now = 0;  // 谷
    Rgb valley[kLedCount];
    anim.render(valley);
    TEST_ASSERT_TRUE(valley[0].b < peak[0].b);
}

// ---- 5. お祝い: レインボー ----

// 画素ごとに色相が異なり（単色一様ではない）、かつ各画素が白ではないこと
static void test_celebration_is_varied_hues_never_white() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kCelebration);
    g_now = 0;
    Rgb frame[kLedCount];
    anim.render(frame);

    // 全画素が同一ではない（色相が回っている）
    bool varied = false;
    for (uint16_t i = 1; i < kLedCount; ++i) {
        if (frame[i].r != frame[0].r || frame[i].g != frame[0].g || frame[i].b != frame[0].b) {
            varied = true;
            break;
        }
    }
    TEST_ASSERT_TRUE(varied);

    // 各画素は必ずいずれか1チャンネルが0（＝白ではない）
    for (uint16_t i = 0; i < kLedCount; ++i) {
        const bool hasZeroChannel = (frame[i].r == 0 || frame[i].g == 0 || frame[i].b == 0);
        TEST_ASSERT_TRUE(hasZeroChannel);
    }
}

// ---- 6. エラー: 赤の速い点滅3回 ----

// 点灯フェーズは赤で、所定時間（周期×3回）で終了判定が立つこと
static void test_error_blinks_red_and_finishes_after_three() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kError);

    // 最初の点灯フェーズ（周期前半）は赤
    g_now = kErrorBlinkPeriodMs / 4;
    Rgb frame[kLedCount];
    anim.render(frame);
    TEST_ASSERT_EQUAL_UINT8(255, frame[0].r);
    TEST_ASSERT_EQUAL_UINT8(0, frame[0].g);
    TEST_ASSERT_EQUAL_UINT8(0, frame[0].b);

    // 3回終わる直前は未終了
    g_now = kErrorBlinkPeriodMs * kErrorBlinkCount - 1;
    TEST_ASSERT_FALSE(anim.isTransientFinished());

    // 3回ぶん経過で終了
    g_now = kErrorBlinkPeriodMs * kErrorBlinkCount;
    TEST_ASSERT_TRUE(anim.isTransientFinished());
}

// ---- 7. 録音破棄・単押し: 黄の短点滅1回 ----

// 点灯フェーズは黄（赤+緑、青=0）で、1回ぶんで終了すること
static void test_discard_blinks_yellow_and_finishes_after_one() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kDiscarded);

    g_now = kDiscardBlinkPeriodMs / 4;
    Rgb frame[kLedCount];
    anim.render(frame);
    TEST_ASSERT_EQUAL_UINT8(255, frame[0].r);
    TEST_ASSERT_EQUAL_UINT8(255, frame[0].g);
    TEST_ASSERT_EQUAL_UINT8(0, frame[0].b);

    g_now = kDiscardBlinkPeriodMs * kDiscardBlinkCount - 1;
    TEST_ASSERT_FALSE(anim.isTransientFinished());
    g_now = kDiscardBlinkPeriodMs * kDiscardBlinkCount;
    TEST_ASSERT_TRUE(anim.isTransientFinished());
}

// ---- 8. キャンセル受理: マゼンタの短点滅2回（v1.3.1で青→変更） ----

// 点灯フェーズはマゼンタ（再生中の青・破棄の黄と区別できる色）で、2回ぶんで終了すること
static void test_cancel_blinks_magenta_and_finishes_after_two() {
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kCancelAccepted);

    g_now = kCancelBlinkPeriodMs / 4;
    Rgb frame[kLedCount];
    anim.render(frame);
    TEST_ASSERT_EQUAL_UINT8(255, frame[0].r);
    TEST_ASSERT_EQUAL_UINT8(0, frame[0].g);
    TEST_ASSERT_EQUAL_UINT8(255, frame[0].b);

    g_now = kCancelBlinkPeriodMs * kCancelBlinkCount - 1;
    TEST_ASSERT_FALSE(anim.isTransientFinished());
    g_now = kCancelBlinkPeriodMs * kCancelBlinkCount;
    TEST_ASSERT_TRUE(anim.isTransientFinished());
}

// ---- 非一過性状態は終了しない ----

// 待機/録音/考え中/再生/お祝いは、時間が経っても isTransientFinished が立たないこと
static void test_non_transient_statuses_never_finish() {
    const LedStatus statuses[] = {
        LedStatus::kIdle, LedStatus::kRecording, LedStatus::kThinking,
        LedStatus::kPlaying, LedStatus::kCelebration,
    };
    for (const LedStatus s : statuses) {
        LedAnimator anim(fakeClock);
        anim.setStatus(s);
        g_now = 1000000;
        TEST_ASSERT_FALSE(anim.isTransientFinished());
    }
}

// ---- setStatus による位相リセット ----

// setStatus で基点時刻がリセットされ、一過性演出の終了判定が切り替え時点から始まること
static void test_setstatus_resets_phase() {
    LedAnimator anim(fakeClock);
    g_now = 5000;
    anim.setStatus(LedStatus::kError);  // 基点 = 5000
    // 5000 + (3回未満) では未終了
    g_now = 5000 + kErrorBlinkPeriodMs * kErrorBlinkCount - 1;
    TEST_ASSERT_FALSE(anim.isTransientFinished());
    // 5000 + 3回ぶんで終了
    g_now = 5000 + kErrorBlinkPeriodMs * kErrorBlinkCount;
    TEST_ASSERT_TRUE(anim.isTransientFinished());
}

// ---- millis() 32bitラップアラウンド境界 ----

// 基点が UINT32_MAX 付近でも、ラップをまたいだ一過性演出の終了判定が正しいこと
static void test_transient_finish_across_millis_wraparound() {
    g_now = UINT32_MAX - 100;
    LedAnimator anim(fakeClock);
    anim.setStatus(LedStatus::kError);  // 基点 = UINT32_MAX - 100
    // まだ3回ぶん経っていない（ラップ直後）
    g_now = static_cast<uint32_t>(g_now + kErrorBlinkPeriodMs * kErrorBlinkCount - 1);
    TEST_ASSERT_FALSE(anim.isTransientFinished());
    g_now = static_cast<uint32_t>(g_now + 1);
    TEST_ASSERT_TRUE(anim.isTransientFinished());
}

// ---- NeoPixel更新間隔 ----

// 初回は即時描画し、20ms未満は省略、境界到達で再描画すること
static void test_render_if_due_limits_refresh_rate() {
    LedAnimator anim(fakeClock);
    Rgb frame[kLedCount];
    TEST_ASSERT_TRUE(anim.renderIfDue(frame));

    g_now += kLedRefreshIntervalMs - 1;
    TEST_ASSERT_FALSE(anim.renderIfDue(frame));
    g_now += 1;
    TEST_ASSERT_TRUE(anim.renderIfDue(frame));
}

// 更新間隔内でも状態変更直後は新しい表示を即時反映すること
static void test_status_change_forces_immediate_refresh() {
    LedAnimator anim(fakeClock);
    Rgb frame[kLedCount];
    TEST_ASSERT_TRUE(anim.renderIfDue(frame));

    g_now += 1;
    anim.setStatus(LedStatus::kRecording);
    TEST_ASSERT_TRUE(anim.renderIfDue(frame));
    TEST_ASSERT_EQUAL_UINT8(255, frame[0].r);
}

// millis()ラップアラウンドをまたいでも更新間隔を正しく判定すること
static void test_refresh_interval_across_millis_wraparound() {
    g_now = UINT32_MAX - 5;
    LedAnimator anim(fakeClock);
    Rgb frame[kLedCount];
    TEST_ASSERT_TRUE(anim.renderIfDue(frame));

    g_now += kLedRefreshIntervalMs - 1;
    TEST_ASSERT_FALSE(anim.renderIfDue(frame));
    g_now += 1;
    TEST_ASSERT_TRUE(anim.renderIfDue(frame));
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_all_statuses_limit_simultaneous_lit_pixels);
    RUN_TEST(test_idle_is_green_and_breathes);
    RUN_TEST(test_recording_is_solid_red);
    RUN_TEST(test_thinking_lights_subset_and_rotates);
    RUN_TEST(test_playing_is_blue_and_blinks);
    RUN_TEST(test_celebration_is_varied_hues_never_white);
    RUN_TEST(test_error_blinks_red_and_finishes_after_three);
    RUN_TEST(test_discard_blinks_yellow_and_finishes_after_one);
    RUN_TEST(test_cancel_blinks_magenta_and_finishes_after_two);
    RUN_TEST(test_non_transient_statuses_never_finish);
    RUN_TEST(test_setstatus_resets_phase);
    RUN_TEST(test_transient_finish_across_millis_wraparound);
    RUN_TEST(test_render_if_due_limits_refresh_rate);
    RUN_TEST(test_status_change_forces_immediate_refresh);
    RUN_TEST(test_refresh_interval_across_millis_wraparound);
    return UNITY_END();
}
