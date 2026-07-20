// button_input::ButtonInput のホスト側ユニットテスト（§6のクリック判定仕様）。
// 実際のGPIO読み取り（G41アクティブロー）は実機確認の対象で、ここでは
// デバウンス・クリック分類の純粋ロジックのみを検証する。
#include <unity.h>

#include <cstdint>

#include "button_input.h"

using button_input::ButtonGesture;
using button_input::ButtonInput;
using button_input::kDebounceMs;
using button_input::kLongPressMs;
using button_input::kMultiClickWindowMs;

namespace {

// テスト用の手動進行クロック（ミリ秒）
uint32_t g_now = 0;

uint32_t fakeClock() {
    return g_now;
}

// デバウンス済みの押下エッジを成立させる。生の押下を与え、デバウンス時間だけ
// 進めてから再度与えることで押下を確定させる。確定した update の戻り値を返す。
ButtonGesture pressDown(ButtonInput& b) {
    b.update(true);
    g_now += kDebounceMs;
    return b.update(true);
}

// デバウンス済みの解放エッジを成立させる。確定した update の戻り値を返す。
ButtonGesture release(ButtonInput& b) {
    b.update(false);
    g_now += kDebounceMs;
    return b.update(false);
}

// 現在のレベルを保ったまま時間を進め、poll（窓満了判定）を1回走らせる。
ButtonGesture advance(ButtonInput& b, bool level, uint32_t ms) {
    g_now += ms;
    return b.update(level);
}

}  // namespace

void setUp() {
    g_now = 0;
}

void tearDown() {}

// ---- デバウンス ----

// デバウンス時間未満の押下は確定せず、isPressed も変化しないこと
static void test_press_not_committed_before_debounce() {
    ButtonInput b(fakeClock);
    b.update(true);
    g_now += kDebounceMs - 1;
    TEST_ASSERT_TRUE(ButtonGesture::kNone == b.update(true));
    TEST_ASSERT_FALSE(b.isPressed());
}

// デバウンス時間を満たすと押下が確定し、isPressed が true になること
static void test_press_committed_after_debounce() {
    ButtonInput b(fakeClock);
    b.update(true);
    g_now += kDebounceMs;
    b.update(true);
    TEST_ASSERT_TRUE(b.isPressed());
}

// デバウンス時間未満で戻るチャタリングはエッジを生成しないこと
static void test_bounce_shorter_than_debounce_is_ignored() {
    ButtonInput b(fakeClock);
    b.update(true);       // 立ち上がり候補
    g_now += kDebounceMs - 1;
    b.update(false);      // 確定前に戻る（チャタリング）
    g_now += kDebounceMs - 1;
    TEST_ASSERT_FALSE(b.isPressed());
}

// ---- 単押し（1回） ----

// 1回の短押しは、押下・解放時点では確定せず、窓満了時に kSinglePress になること
static void test_single_click_resolves_at_window_expiry() {
    ButtonInput b(fakeClock);
    TEST_ASSERT_TRUE(ButtonGesture::kNone == pressDown(b));
    TEST_ASSERT_TRUE(ButtonGesture::kNone == release(b));  // 窓内なので未確定
    // 窓満了まで進める
    const ButtonGesture g = advance(b, false, kMultiClickWindowMs);
    TEST_ASSERT_TRUE(ButtonGesture::kSinglePress == g);
}

// 窓満了前は単押しフィードバックを確定しないこと（§6: 黄点滅は窓確定後）
static void test_single_click_not_resolved_within_window() {
    ButtonInput b(fakeClock);
    pressDown(b);
    release(b);
    const ButtonGesture g = advance(b, false, kMultiClickWindowMs / 2);
    TEST_ASSERT_TRUE(ButtonGesture::kNone == g);
}

// ---- 単押し（2回＝ダブル） ----

// 2回の短押し（ダブルクリック）も単押し扱いで kSinglePress になること
static void test_double_click_resolves_as_single_press() {
    ButtonInput b(fakeClock);
    pressDown(b);
    release(b);
    pressDown(b);
    TEST_ASSERT_TRUE(ButtonGesture::kNone == release(b));
    const ButtonGesture g = advance(b, false, kMultiClickWindowMs);
    TEST_ASSERT_TRUE(ButtonGesture::kSinglePress == g);
}

// ---- 長押し ----

// 1.5秒以上保持して解放すると kLongPress になること
static void test_long_press_resolves_on_release() {
    ButtonInput b(fakeClock);
    TEST_ASSERT_TRUE(ButtonGesture::kNone == pressDown(b));
    // 保持中は窓が満了しても確定しない
    TEST_ASSERT_TRUE(ButtonGesture::kNone == advance(b, true, kLongPressMs));
    const ButtonGesture g = release(b);
    TEST_ASSERT_TRUE(ButtonGesture::kLongPress == g);
}

// 保持時間がちょうど境界（1.5秒）なら長押しになること（>= 判定）
static void test_hold_exactly_at_boundary_is_long_press() {
    ButtonInput b(fakeClock);
    pressDown(b);
    // release() は解放前に update(false)、その後 kDebounceMs 進めて確定する。
    // 確定時の保持時間 = (保持分) + kDebounceMs。ちょうど kLongPressMs にするため
    // 保持分を kLongPressMs - kDebounceMs にする。
    g_now += kLongPressMs - kDebounceMs;
    const ButtonGesture g = release(b);
    TEST_ASSERT_TRUE(ButtonGesture::kLongPress == g);
}

// 保持時間が境界未満なら長押しにならず、単押しとして扱われること
static void test_hold_just_below_boundary_is_not_long_press() {
    ButtonInput b(fakeClock);
    pressDown(b);
    g_now += kLongPressMs - kDebounceMs - 1;  // 確定時の保持 = kLongPressMs - 1
    const ButtonGesture g = release(b);
    TEST_ASSERT_TRUE(ButtonGesture::kLongPress != g);
}

// ---- トリプルクリック ----

// 窓内に3回押下すると、3回目の押下エッジで即時に kTripleClick になること
static void test_triple_click_resolves_immediately_on_third_press() {
    ButtonInput b(fakeClock);
    pressDown(b);
    release(b);
    pressDown(b);
    release(b);
    const ButtonGesture g = pressDown(b);  // 3回目の押下
    TEST_ASSERT_TRUE(ButtonGesture::kTripleClick == g);
}

// トリプルクリック確定後、その3回目の解放は新たなジェスチャを生まないこと
static void test_triple_click_swallows_its_third_release() {
    ButtonInput b(fakeClock);
    pressDown(b);
    release(b);
    pressDown(b);
    release(b);
    pressDown(b);  // kTripleClick
    TEST_ASSERT_TRUE(ButtonGesture::kNone == release(b));
    // 以降、窓満了相当に進めても余分なジェスチャは出ない
    TEST_ASSERT_TRUE(ButtonGesture::kNone == advance(b, false, kMultiClickWindowMs));
}

// 3回目の押下が窓を過ぎている場合はトリプルにならず、先行2クリックは単押しとして
// 確定し、3回目は新しいシーケンスの初回押下になること（§6: 窓延長なし）
static void test_third_press_after_window_is_new_sequence_not_triple() {
    ButtonInput b(fakeClock);
    pressDown(b);
    release(b);
    pressDown(b);
    release(b);
    // 2クリック目の解放後、窓満了まで進める → 単押し確定
    const ButtonGesture expired = advance(b, false, kMultiClickWindowMs);
    TEST_ASSERT_TRUE(ButtonGesture::kSinglePress == expired);
    // 続く押下は新シーケンスの初回。トリプルにはならない
    const ButtonGesture third = pressDown(b);
    TEST_ASSERT_TRUE(ButtonGesture::kNone == third);
}

// ---- 窓と保持の相互作用 ----

// 初回押下を窓超え〜長押し境界未満（1.2〜1.5秒）で保持して解放すると、
// 窓は満了済みのため解放時点で即 kSinglePress になること
static void test_first_press_held_past_window_below_long_resolves_single() {
    ButtonInput b(fakeClock);
    pressDown(b);
    // 保持を進める。確定時保持 = 保持分 + kDebounceMs が (窓, 長押し境界) に入るようにする
    const uint32_t holdMs = kMultiClickWindowMs + 100 - kDebounceMs;  // 確定時 1300ms 相当
    g_now += holdMs;
    const ButtonGesture g = release(b);
    TEST_ASSERT_TRUE(ButtonGesture::kSinglePress == g);
}

// 長押し後は新しいシーケンスとして扱われ、続く単押しが独立に確定すること
// （長押しがマルチクリックに巻き込まれない）
static void test_long_press_does_not_absorb_following_click() {
    ButtonInput b(fakeClock);
    pressDown(b);
    g_now += kLongPressMs;
    TEST_ASSERT_TRUE(ButtonGesture::kLongPress == release(b));
    // 続く単押しは新シーケンスとして単押し確定する
    pressDown(b);
    release(b);
    const ButtonGesture g = advance(b, false, kMultiClickWindowMs);
    TEST_ASSERT_TRUE(ButtonGesture::kSinglePress == g);
}

// ---- 初期状態 ----

// 何も操作しなければジェスチャは出ず、isPressed は false のままであること
static void test_idle_produces_no_gesture() {
    ButtonInput b(fakeClock);
    TEST_ASSERT_TRUE(ButtonGesture::kNone == b.update(false));
    g_now += kMultiClickWindowMs * 10;
    TEST_ASSERT_TRUE(ButtonGesture::kNone == b.update(false));
    TEST_ASSERT_FALSE(b.isPressed());
}

// ---- millis() 32bitラップアラウンド境界 ----

// 押下開始が UINT32_MAX 付近でも、ラップをまたいだ長押し判定が正しく働くこと
static void test_long_press_across_millis_wraparound() {
    g_now = UINT32_MAX - 100;
    ButtonInput b(fakeClock);
    pressDown(b);
    g_now += kLongPressMs;  // ラップをまたぐ
    const ButtonGesture g = release(b);
    TEST_ASSERT_TRUE(ButtonGesture::kLongPress == g);
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_press_not_committed_before_debounce);
    RUN_TEST(test_press_committed_after_debounce);
    RUN_TEST(test_bounce_shorter_than_debounce_is_ignored);
    RUN_TEST(test_single_click_resolves_at_window_expiry);
    RUN_TEST(test_single_click_not_resolved_within_window);
    RUN_TEST(test_double_click_resolves_as_single_press);
    RUN_TEST(test_long_press_resolves_on_release);
    RUN_TEST(test_hold_exactly_at_boundary_is_long_press);
    RUN_TEST(test_hold_just_below_boundary_is_not_long_press);
    RUN_TEST(test_triple_click_resolves_immediately_on_third_press);
    RUN_TEST(test_triple_click_swallows_its_third_release);
    RUN_TEST(test_third_press_after_window_is_new_sequence_not_triple);
    RUN_TEST(test_first_press_held_past_window_below_long_resolves_single);
    RUN_TEST(test_long_press_does_not_absorb_following_click);
    RUN_TEST(test_idle_produces_no_gesture);
    RUN_TEST(test_long_press_across_millis_wraparound);
    return UNITY_END();
}
