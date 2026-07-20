// state_machine::StateMachine のホスト側ユニットテスト（§3.5・§5・§6・アプリ処理フロー）。
// 実GPIO/USB CDC/NeoPixel/I2Sを伴う main.cpp の配線は実機確認の対象。ここでは状態遷移と
// StateMachine が返す Action（副作用の指示）の正しさを検証する。
#include <unity.h>

#include <cstdint>

#include "state_machine.h"

using audio_playback::EffectId;
using audio_record::StopResult;
using button_input::ButtonGesture;
using led_controller::LedStatus;
using serial_link::kAcceptTimeoutMs;
using serial_link::kResponseTimeoutMs;
using state_machine::Action;
using state_machine::AppState;
using state_machine::kRecordingLedDelayMs;
using state_machine::StateMachine;

namespace {

// テスト用の手動進行クロック（ミリ秒）
uint32_t g_now = 0;

uint32_t fakeClock() { return g_now; }

void advanceToWaitingAccept(StateMachine& sm) {
    sm.onButtonPressDown();                       // 待機→録音
    sm.reportRecorderStopped(StopResult::kKept);  // 録音→0x01送信要求
    sm.onRecordedAudioSent();                     // 物理送信成功→0x02待ち開始
}

void advanceToThinking(StateMachine& sm) {
    advanceToWaitingAccept(sm);
    sm.onAcceptReceived();  // 0x02受信→考え中
}

}  // namespace

void setUp() { g_now = 0; }

void tearDown() {}

// ---- 初期状態 ----

// 構築直後は待機状態であること
static void test_initial_state_is_idle() {
    StateMachine sm(fakeClock);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
}

// ---- 録音ライフサイクル（§6・§4.1） ----

// 待機中の押下で録音を開始するが、赤LEDは即時には出さないこと（タップの一瞬赤を防ぐ）
static void test_press_down_in_idle_starts_recording_without_immediate_led() {
    StateMachine sm(fakeClock);
    const Action a = sm.onButtonPressDown();
    TEST_ASSERT_TRUE(AppState::kRecording == sm.state());
    TEST_ASSERT_TRUE(a.startRecording);
    TEST_ASSERT_FALSE(a.setLed);  // 録音データは開始するが赤LEDは遅延させる
}

// 赤LEDのしきい値が長押し境界（会話開始確定＝kKept境界）と一致すること
static void test_recording_led_threshold_equals_long_press() {
    TEST_ASSERT_EQUAL_UINT32(button_input::kLongPressMs, kRecordingLedDelayMs);
}

// 録音が kRecordingLedDelayMs（長押し境界）続いたら poll() が赤LEDを出し、以後は繰り返さないこと
static void test_recording_led_shown_after_delay() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    TEST_ASSERT_FALSE(sm.poll().setLed);  // 遅延前は赤にしない
    g_now += kRecordingLedDelayMs;
    const Action a = sm.poll();
    TEST_ASSERT_TRUE(a.setLed);
    TEST_ASSERT_TRUE(LedStatus::kRecording == a.led);
    g_now += kRecordingLedDelayMs * 5;
    TEST_ASSERT_FALSE(sm.poll().setLed);  // 同じ録音では二度出さない
}

// 遅延未満で解放されたタップは、赤LEDを一度も経由せず待機へ戻ること
static void test_quick_tap_never_shows_recording_led() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    g_now += kRecordingLedDelayMs - 1;
    TEST_ASSERT_FALSE(sm.poll().setLed);  // 遅延未満なので赤は出ていない
    sm.onButtonRelease();
    const Action d = sm.reportRecorderStopped(StopResult::kDiscarded);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kIdle == d.led);  // 破棄後は待機（緑）。赤を経由しない
}

// 待機中以外の押下は無視され、録音を開始しないこと（§6: 考え中・再生中の誤操作防止）
static void test_press_down_when_thinking_is_ignored() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    const Action a = sm.onButtonPressDown();
    TEST_ASSERT_TRUE(AppState::kThinking == sm.state());
    TEST_ASSERT_FALSE(a.startRecording);
    TEST_ASSERT_FALSE(a.setLed);
}

// 録音中の解放は停止要求を返すが、停止結果が来るまでは録音状態を維持すること
static void test_release_while_recording_requests_stop() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    const Action a = sm.onButtonRelease();
    TEST_ASSERT_TRUE(a.stopRecording);
    TEST_ASSERT_TRUE(AppState::kRecording == sm.state());  // 結果待ち
}

// 待機中の解放（録音していない）は何もしないこと
static void test_release_while_idle_is_noop() {
    StateMachine sm(fakeClock);
    const Action a = sm.onButtonRelease();
    TEST_ASSERT_FALSE(a.stopRecording);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
}

// 最短録音長以上で停止したら0x01送信を要求し、送信完了待ち状態へ入ること
static void test_recorder_kept_requests_audio_send() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    const Action a = sm.reportRecorderStopped(StopResult::kKept);
    TEST_ASSERT_TRUE(AppState::kWaitingAccept == sm.state());
    TEST_ASSERT_TRUE(a.sendRecordedAudio);
    TEST_ASSERT_TRUE(a.setLed);
    TEST_ASSERT_TRUE(LedStatus::kIdle == a.led);
}

// 0x01送信成功後にだけ3秒タイマーが開始すること
static void test_accept_timer_starts_after_physical_send() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    sm.reportRecorderStopped(StopResult::kKept);
    g_now += kAcceptTimeoutMs * 2;
    TEST_ASSERT_FALSE(sm.poll().setLed);  // 送信中の時間は3秒枠へ含めない
    sm.onRecordedAudioSent();
    g_now += kAcceptTimeoutMs;
    const Action timeout = sm.poll();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == timeout.led);
}

// 最短録音長未満（kDiscarded）は無音で待機へ戻すこと（黄点滅は単押しジェスチャで表示）
static void test_recorder_discarded_returns_to_idle_silently() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    const Action a = sm.reportRecorderStopped(StopResult::kDiscarded);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_FALSE(a.sendRecordedAudio);
    TEST_ASSERT_TRUE(LedStatus::kIdle == a.led);
}

// 録音処理エラー（kError）はエラー点滅へ遷移すること
static void test_recorder_error_enters_error_blink() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    const Action a = sm.reportRecorderStopped(StopResult::kError);
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// 録音状態でないときの stop 結果報告は無視されること（トリプルクリック後の遅延報告対策）
static void test_report_recorder_stopped_ignored_when_not_recording() {
    StateMachine sm(fakeClock);
    const Action a = sm.reportRecorderStopped(StopResult::kKept);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_FALSE(a.sendRecordedAudio);
}

// マイク開始失敗はエラー点滅へ遷移すること
static void test_recorder_start_failed_enters_error_blink() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    const Action a = sm.onRecorderStartFailed();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// ---- 受信コマンド（§3.3・アプリ処理フロー5） ----

// 0x02受信で初めて考え中へ入り、スピナー表示を開始すること
static void test_accept_received_enters_thinking() {
    StateMachine sm(fakeClock);
    advanceToWaitingAccept(sm);
    g_now += 100;
    const Action a = sm.onAcceptReceived();
    TEST_ASSERT_TRUE(AppState::kThinking == sm.state());
    TEST_ASSERT_TRUE(a.setLed);
    TEST_ASSERT_TRUE(LedStatus::kThinking == a.led);
}

// 考え中でない 0x02 受信は無視されること
static void test_accept_received_when_idle_is_ignored() {
    StateMachine sm(fakeClock);
    const Action a = sm.onAcceptReceived();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

static void test_accept_with_body_is_rejected() {
    StateMachine sm(fakeClock);
    advanceToWaitingAccept(sm);
    const Action a = sm.onAcceptReceived(1);
    TEST_ASSERT_TRUE(AppState::kWaitingAccept == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

// 考え中の 0x03（通常応答）受信で再生を開始し、青明滅LEDを要求すること
static void test_play_received_normal_starts_playback() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    const Action a = sm.onPlayReceived(EffectId::kNormal);
    TEST_ASSERT_TRUE(AppState::kPlaying == sm.state());
    TEST_ASSERT_TRUE(a.startPlayback);
    TEST_ASSERT_TRUE(LedStatus::kPlaying == a.led);
}

// 0x03（お祝いエフェクト）受信ではお祝いLED（レインボー）を要求すること
static void test_play_received_celebration_uses_celebration_led() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    const Action a = sm.onPlayReceived(EffectId::kCelebration);
    TEST_ASSERT_TRUE(AppState::kPlaying == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kCelebration == a.led);
}

// 0x02より前に届いた0x03は無視すること
static void test_play_received_before_accept_is_ignored() {
    StateMachine sm(fakeClock);
    advanceToWaitingAccept(sm);
    const Action a = sm.onPlayReceived(EffectId::kNormal);
    TEST_ASSERT_TRUE(AppState::kWaitingAccept == sm.state());
    TEST_ASSERT_FALSE(a.startPlayback);
}

// 35秒期限ちょうどに届いた0x03は再生せずエラーにすること
static void test_play_received_at_response_deadline_errors() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    g_now += kResponseTimeoutMs;
    const Action a = sm.onPlayReceived(EffectId::kNormal);
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_FALSE(a.startPlayback);
}

// 考え中でない 0x03 受信は無視され、再生を開始しないこと
static void test_play_received_when_idle_is_ignored() {
    StateMachine sm(fakeClock);
    const Action a = sm.onPlayReceived(EffectId::kNormal);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_FALSE(a.startPlayback);
}

// 考え中の 0x04 受信はエラー点滅へ遷移すること（§3.5）
static void test_error_received_enters_error_blink() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    const Action a = sm.onErrorReceived();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// 考え中でない 0x04 受信は無視されること
static void test_error_received_when_idle_is_ignored() {
    StateMachine sm(fakeClock);
    const Action a = sm.onErrorReceived();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

static void test_error_with_body_is_rejected() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    const Action a = sm.onErrorReceived(1);
    TEST_ASSERT_TRUE(AppState::kThinking == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

// ---- タイムアウト（§3.5） ----

// 0x02 が3秒来ないとエラー点滅へ遷移すること
static void test_accept_timeout_enters_error() {
    StateMachine sm(fakeClock);
    advanceToWaitingAccept(sm);
    g_now += kAcceptTimeoutMs;
    const Action a = sm.poll();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// 0x02 受信後 0x03/0x04 が35秒来ないとエラー点滅へ遷移すること
static void test_response_timeout_enters_error() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    g_now += kResponseTimeoutMs;
    const Action a = sm.poll();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// 待機中の poll はタイムアウトしないこと
static void test_poll_in_idle_never_times_out() {
    StateMachine sm(fakeClock);
    g_now += kResponseTimeoutMs * 10;
    const Action a = sm.poll();
    TEST_ASSERT_FALSE(a.setLed);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
}

// 再生中の poll はハンドシェイクのタイムアウトで割り込まれないこと
static void test_poll_while_playing_does_not_error() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    sm.onPlayReceived(EffectId::kNormal);
    g_now += kResponseTimeoutMs * 2;
    const Action a = sm.poll();
    TEST_ASSERT_FALSE(a.setLed);
    TEST_ASSERT_TRUE(AppState::kPlaying == sm.state());
}

// millis の32bitラップアラウンドをまたいでも 0x02 タイムアウトを正しく検知すること
static void test_accept_timeout_across_millis_wraparound() {
    g_now = UINT32_MAX - 1000;
    StateMachine sm(fakeClock);
    advanceToWaitingAccept(sm);
    g_now += kAcceptTimeoutMs;  // ラップをまたいでちょうど期限
    const Action a = sm.poll();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// ---- 再生完了・失敗 ----

// 再生完了で待機へ復帰すること
static void test_playback_finished_returns_to_idle() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    sm.onPlayReceived(EffectId::kNormal);
    const Action a = sm.onPlaybackFinished();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kIdle == a.led);
}

// 再生失敗はエラー点滅へ遷移すること
static void test_playback_error_enters_error_blink() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    sm.onPlayReceived(EffectId::kNormal);
    const Action a = sm.onPlaybackError();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// 再生中でないときの再生完了報告は無視されること
static void test_playback_finished_ignored_when_not_playing() {
    StateMachine sm(fakeClock);
    const Action a = sm.onPlaybackFinished();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

// ---- 送信失敗 ----

// 0x01 送信失敗はエラー点滅へ遷移すること
static void test_send_failure_enters_error_blink() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    sm.reportRecorderStopped(StopResult::kKept);
    const Action a = sm.onSendFailure();
    TEST_ASSERT_TRUE(AppState::kErrorBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kError == a.led);
}

// ---- ボタンジェスチャ（§6） ----

// 待機中のトリプルクリックは 0x05 送信＋青2回点滅で待機へ復帰する準備をすること
static void test_triple_click_from_idle_sends_cancel() {
    StateMachine sm(fakeClock);
    const Action a = sm.onButtonGesture(ButtonGesture::kTripleClick);
    TEST_ASSERT_TRUE(AppState::kCancelBlink == sm.state());
    TEST_ASSERT_TRUE(a.sendCancel);
    TEST_ASSERT_TRUE(LedStatus::kCancelAccepted == a.led);
    TEST_ASSERT_FALSE(a.stopPlayback);
    TEST_ASSERT_FALSE(a.stopRecording);
}

// 録音中のトリプルクリックは録音停止（破棄）＋0x05送信を要求すること
static void test_triple_click_while_recording_stops_recording() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    const Action a = sm.onButtonGesture(ButtonGesture::kTripleClick);
    TEST_ASSERT_TRUE(AppState::kCancelBlink == sm.state());
    TEST_ASSERT_TRUE(a.sendCancel);
    TEST_ASSERT_TRUE(a.stopRecording);
}

// 再生中のトリプルクリックは再生即時停止＋0x05送信を要求すること
static void test_triple_click_while_playing_stops_playback() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    sm.onPlayReceived(EffectId::kNormal);
    const Action a = sm.onButtonGesture(ButtonGesture::kTripleClick);
    TEST_ASSERT_TRUE(AppState::kCancelBlink == sm.state());
    TEST_ASSERT_TRUE(a.sendCancel);
    TEST_ASSERT_TRUE(a.stopPlayback);
}

// 考え中のトリプルクリックはハンドシェイクタイマーもリセットし、以後誤タイムアウトしないこと
static void test_triple_click_while_thinking_resets_timer() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    sm.onButtonGesture(ButtonGesture::kTripleClick);
    g_now += kResponseTimeoutMs * 2;
    const Action a = sm.poll();
    TEST_ASSERT_FALSE(a.setLed);
    TEST_ASSERT_TRUE(AppState::kCancelBlink == sm.state());
}

// 待機中の単押しは黄点滅（録音破棄フィードバック）を要求すること（§5-7・§6）
static void test_single_press_in_idle_shows_discard_blink() {
    StateMachine sm(fakeClock);
    const Action a = sm.onButtonGesture(ButtonGesture::kSinglePress);
    TEST_ASSERT_TRUE(AppState::kDiscardBlink == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kDiscarded == a.led);
}

// 待機中以外の単押しは無視されること（§6）
static void test_single_press_when_thinking_is_ignored() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    const Action a = sm.onButtonGesture(ButtonGesture::kSinglePress);
    TEST_ASSERT_TRUE(AppState::kThinking == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

// 長押しジェスチャ自体は状態を変えないこと（録音停止は解放エッジ側で駆動する）
static void test_long_press_gesture_is_noop() {
    StateMachine sm(fakeClock);
    sm.onButtonPressDown();
    const Action a = sm.onButtonGesture(ButtonGesture::kLongPress);
    TEST_ASSERT_TRUE(AppState::kRecording == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

// ---- 一過性LED完了 → 待機復帰（§5） ----

// エラー点滅完了で待機へ復帰すること
static void test_transient_finished_from_error_returns_to_idle() {
    StateMachine sm(fakeClock);
    advanceToThinking(sm);
    sm.onErrorReceived();  // → kErrorBlink
    const Action a = sm.onTransientFinished();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kIdle == a.led);
}

// 黄点滅完了で待機へ復帰すること
static void test_transient_finished_from_discard_returns_to_idle() {
    StateMachine sm(fakeClock);
    sm.onButtonGesture(ButtonGesture::kSinglePress);  // → kDiscardBlink
    const Action a = sm.onTransientFinished();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
}

// キャンセル点滅完了で待機へ復帰すること
static void test_transient_finished_from_cancel_returns_to_idle() {
    StateMachine sm(fakeClock);
    sm.onButtonGesture(ButtonGesture::kTripleClick);  // → kCancelBlink
    const Action a = sm.onTransientFinished();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
}

// 一過性でない状態（待機）での完了通知は無視されること
static void test_transient_finished_when_idle_is_ignored() {
    StateMachine sm(fakeClock);
    const Action a = sm.onTransientFinished();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_FALSE(a.setLed);
}

// ---- 一連の正常フロー（統合） ----

// 待機→録音→送信→0x02待ち→考え中→0x03→再生→再生完了→待機の一巡を検証する
static void test_full_happy_path_round_trip() {
    StateMachine sm(fakeClock);
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());

    sm.onButtonPressDown();
    TEST_ASSERT_TRUE(AppState::kRecording == sm.state());

    g_now += 2000;  // 2秒録音（最短1.5秒以上）
    const Action kept = sm.reportRecorderStopped(StopResult::kKept);
    TEST_ASSERT_TRUE(kept.sendRecordedAudio);
    TEST_ASSERT_TRUE(AppState::kWaitingAccept == sm.state());

    g_now += 4000;  // 物理送信に3秒以上かかっても、まだ0x02タイムアウトにはしない
    sm.onRecordedAudioSent();

    g_now += 500;
    sm.onAcceptReceived();  // 0x02（3秒以内）
    TEST_ASSERT_TRUE(AppState::kThinking == sm.state());

    g_now += 3000;
    const Action play = sm.onPlayReceived(EffectId::kNormal);  // 0x03（35秒以内）
    TEST_ASSERT_TRUE(play.startPlayback);
    TEST_ASSERT_TRUE(AppState::kPlaying == sm.state());

    const Action fin = sm.onPlaybackFinished();
    TEST_ASSERT_TRUE(AppState::kIdle == sm.state());
    TEST_ASSERT_TRUE(LedStatus::kIdle == fin.led);
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_initial_state_is_idle);
    RUN_TEST(test_press_down_in_idle_starts_recording_without_immediate_led);
    RUN_TEST(test_recording_led_threshold_equals_long_press);
    RUN_TEST(test_recording_led_shown_after_delay);
    RUN_TEST(test_quick_tap_never_shows_recording_led);
    RUN_TEST(test_press_down_when_thinking_is_ignored);
    RUN_TEST(test_release_while_recording_requests_stop);
    RUN_TEST(test_release_while_idle_is_noop);
    RUN_TEST(test_recorder_kept_requests_audio_send);
    RUN_TEST(test_accept_timer_starts_after_physical_send);
    RUN_TEST(test_recorder_discarded_returns_to_idle_silently);
    RUN_TEST(test_recorder_error_enters_error_blink);
    RUN_TEST(test_report_recorder_stopped_ignored_when_not_recording);
    RUN_TEST(test_recorder_start_failed_enters_error_blink);
    RUN_TEST(test_accept_received_enters_thinking);
    RUN_TEST(test_accept_received_when_idle_is_ignored);
    RUN_TEST(test_accept_with_body_is_rejected);
    RUN_TEST(test_play_received_normal_starts_playback);
    RUN_TEST(test_play_received_celebration_uses_celebration_led);
    RUN_TEST(test_play_received_before_accept_is_ignored);
    RUN_TEST(test_play_received_at_response_deadline_errors);
    RUN_TEST(test_play_received_when_idle_is_ignored);
    RUN_TEST(test_error_received_enters_error_blink);
    RUN_TEST(test_error_received_when_idle_is_ignored);
    RUN_TEST(test_error_with_body_is_rejected);
    RUN_TEST(test_accept_timeout_enters_error);
    RUN_TEST(test_response_timeout_enters_error);
    RUN_TEST(test_poll_in_idle_never_times_out);
    RUN_TEST(test_poll_while_playing_does_not_error);
    RUN_TEST(test_accept_timeout_across_millis_wraparound);
    RUN_TEST(test_playback_finished_returns_to_idle);
    RUN_TEST(test_playback_error_enters_error_blink);
    RUN_TEST(test_playback_finished_ignored_when_not_playing);
    RUN_TEST(test_send_failure_enters_error_blink);
    RUN_TEST(test_triple_click_from_idle_sends_cancel);
    RUN_TEST(test_triple_click_while_recording_stops_recording);
    RUN_TEST(test_triple_click_while_playing_stops_playback);
    RUN_TEST(test_triple_click_while_thinking_resets_timer);
    RUN_TEST(test_single_press_in_idle_shows_discard_blink);
    RUN_TEST(test_single_press_when_thinking_is_ignored);
    RUN_TEST(test_long_press_gesture_is_noop);
    RUN_TEST(test_transient_finished_from_error_returns_to_idle);
    RUN_TEST(test_transient_finished_from_discard_returns_to_idle);
    RUN_TEST(test_transient_finished_from_cancel_returns_to_idle);
    RUN_TEST(test_transient_finished_when_idle_is_ignored);
    RUN_TEST(test_full_happy_path_round_trip);
    return UNITY_END();
}
