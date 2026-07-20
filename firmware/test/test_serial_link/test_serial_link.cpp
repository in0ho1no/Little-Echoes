// serial_link::HandshakeTimer のホスト側ユニットテスト。
// begin()/sendReady()等の実シリアルI/O関数はArduinoフレームワーク限定
// （ARDUINOマクロ内でのみ定義）のためnative環境の対象外。実機での動作確認が必要。
#include <unity.h>

#include <cstdint>

#include "serial_link.h"

using serial_link::HandshakeTimer;
using serial_link::kAcceptTimeoutMs;
using serial_link::kResponseTimeoutMs;
using serial_link::TimeoutEvent;

namespace {

// テスト用の手動進行クロック（ミリ秒）
uint32_t g_fakeNowMs = 0;

uint32_t fakeClock() {
    return g_fakeNowMs;
}

}  // namespace

void setUp() {
    g_fakeNowMs = 0;
}

void tearDown() {}

// ---- 初期状態 ----

// 何もイベントが起きていなければ、時間が経過してもタイムアウトしないこと
static void test_idle_never_times_out() {
    HandshakeTimer timer(fakeClock);
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
    g_fakeNowMs += kResponseTimeoutMs * 10;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// ---- 0x02待ち（kAcceptTimeoutMs = 3秒） ----

// 期限内であればタイムアウトしないこと
static void test_accept_wait_no_timeout_within_deadline() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs - 1;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// 経過時間がちょうど期限ならタイムアウトすること（PacketParserの>=判定と統一）
static void test_accept_wait_times_out_at_exact_deadline() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kAcceptTimeout == timer.poll());
}

// タイムアウト後は待機状態へ戻り、以後のpollはkNoneであること
static void test_accept_timeout_returns_to_idle() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kAcceptTimeout == timer.poll());
    g_fakeNowMs += kResponseTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// 0x02受信前でも0x02受信後(0x03/0x04待ち)へ遷移すればkAcceptTimeoutは発生しないこと
static void test_accept_received_before_deadline_prevents_accept_timeout() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs - 1;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += 10;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// ---- 0x03/0x04待ち（kResponseTimeoutMs = 35秒） ----

// 期限内であればタイムアウトしないこと
static void test_response_wait_no_timeout_within_deadline() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs - 1;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// 経過時間がちょうど期限ならタイムアウトすること
static void test_response_wait_times_out_at_exact_deadline() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kResponseTimeout == timer.poll());
}

// タイムアウト後は待機状態へ戻ること
static void test_response_timeout_returns_to_idle() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kResponseTimeout == timer.poll());
    g_fakeNowMs += kResponseTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// 期限内に0x03/0x04相当の受理があればタイムアウトしないこと
static void test_response_received_before_deadline_prevents_response_timeout() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs - 1;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onResponseReceived());
    g_fakeNowMs += 10;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// ---- 正常な一連の流れ ----

// 0x01送信→0x02受信→0x03/0x04受信の一連の流れで、途中いずれのタイムアウトも
// 発生しないこと
static void test_full_handshake_round_trip_produces_no_timeout() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += 500;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
    g_fakeNowMs += 20000;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onResponseReceived());
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// ---- 想定外タイミングでのイベントは無視されること ----

// 待機中（kIdle）に届いた不意の0x02受信は無視され、状態遷移しないこと
static void test_accept_received_while_idle_is_ignored() {
    HandshakeTimer timer(fakeClock);
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    // 0x02待ちへ遷移していなければ、35秒経ってもresponse timeoutは起きない
    g_fakeNowMs += kResponseTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// 0x02待ちタイムアウト後に遅延到着した0x02は無視され、再びkWaitingResponseへ
// 誤って遷移しないこと
static void test_late_accept_after_accept_timeout_is_ignored() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kAcceptTimeout == timer.poll());

    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// pollを先に呼ばなくても、期限ちょうどに到着した0x02はタイムアウトとして扱うこと
static void test_accept_at_deadline_times_out_during_event_handling() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs;

    TEST_ASSERT_TRUE(TimeoutEvent::kAcceptTimeout == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// pollを先に呼ばなくても、期限を超えて到着した0x03/0x04はタイムアウトとして扱うこと
static void test_response_after_deadline_times_out_during_event_handling() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs + 1;

    TEST_ASSERT_TRUE(TimeoutEvent::kResponseTimeout == timer.onResponseReceived());
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// 0x02待ち中に届いた不意の0x03/0x04相当の受信は無視され、0x02待ちが継続すること
static void test_response_received_while_waiting_accept_is_ignored() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onResponseReceived());
    g_fakeNowMs += kAcceptTimeoutMs;
    TEST_ASSERT_TRUE(TimeoutEvent::kAcceptTimeout == timer.poll());
}

// 0x02の二重受信では、2回目の受信でタイマーが再スタートされないこと
// （2回目呼び出し時点からさらに35秒待つわけではない）
static void test_duplicate_accept_received_does_not_restart_response_timer() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs - 1;
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());  // 二重受信。無視されるべき
    g_fakeNowMs += 1;
    TEST_ASSERT_TRUE(TimeoutEvent::kResponseTimeout == timer.poll());
}

// ---- reset() ----

// resetで待機状態へ戻ると、既に期限切れの時刻でもタイムアウトが発生しないこと
static void test_reset_suppresses_pending_timeout() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs;
    timer.reset();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// resetは0x02待ち中でも0x03/0x04待ち中でも待機状態へ戻せること
static void test_reset_from_waiting_response() {
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.onAcceptReceived());
    g_fakeNowMs += kResponseTimeoutMs;
    timer.reset();
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// ---- millis() 32bitラップアラウンド境界（組込み特有の観点） ----

// 0x02待ち中に時刻がラップしても、期限内なら誤ってタイムアウトしないこと
static void test_accept_wait_no_timeout_across_millis_wraparound() {
    g_fakeNowMs = UINT32_MAX - 1000;
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs - 1;  // ラップをまたいで期限直前まで進める
    TEST_ASSERT_TRUE(TimeoutEvent::kNone == timer.poll());
}

// 0x02待ち中に時刻がラップし、期限を超えたら正しくタイムアウトすること
static void test_accept_wait_times_out_across_millis_wraparound() {
    g_fakeNowMs = UINT32_MAX - 1000;
    HandshakeTimer timer(fakeClock);
    timer.onRecordedAudioSent();
    g_fakeNowMs += kAcceptTimeoutMs;  // ラップをまたいでちょうど期限
    TEST_ASSERT_TRUE(TimeoutEvent::kAcceptTimeout == timer.poll());
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_idle_never_times_out);
    RUN_TEST(test_accept_wait_no_timeout_within_deadline);
    RUN_TEST(test_accept_wait_times_out_at_exact_deadline);
    RUN_TEST(test_accept_timeout_returns_to_idle);
    RUN_TEST(test_accept_received_before_deadline_prevents_accept_timeout);
    RUN_TEST(test_response_wait_no_timeout_within_deadline);
    RUN_TEST(test_response_wait_times_out_at_exact_deadline);
    RUN_TEST(test_response_timeout_returns_to_idle);
    RUN_TEST(test_response_received_before_deadline_prevents_response_timeout);
    RUN_TEST(test_full_handshake_round_trip_produces_no_timeout);
    RUN_TEST(test_accept_received_while_idle_is_ignored);
    RUN_TEST(test_late_accept_after_accept_timeout_is_ignored);
    RUN_TEST(test_accept_at_deadline_times_out_during_event_handling);
    RUN_TEST(test_response_after_deadline_times_out_during_event_handling);
    RUN_TEST(test_response_received_while_waiting_accept_is_ignored);
    RUN_TEST(test_duplicate_accept_received_does_not_restart_response_timer);
    RUN_TEST(test_reset_suppresses_pending_timeout);
    RUN_TEST(test_reset_from_waiting_response);
    RUN_TEST(test_accept_wait_no_timeout_across_millis_wraparound);
    RUN_TEST(test_accept_wait_times_out_across_millis_wraparound);
    return UNITY_END();
}
