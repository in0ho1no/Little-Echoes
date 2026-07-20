// メイン状態遷移統合。docs/SPEC.md §3.4/§3.5・§5・§6・アプリ処理フロー に基づく。
//
// 設計方針: 他モジュール（serial_link/button_input/led_controller/audio_record/
// audio_playback）と同様、状態遷移の中核ロジックをハードウェア非依存の `StateMachine`
// へ切り出し、PlatformIO native環境でホスト側ユニットテスト可能にする。実際のGPIO読み取り・
// USB CDC送受信・NeoPixel駆動・I2S録音再生は `#ifdef ARDUINO` の main.cpp が担い、
// StateMachine が返す `Action` を実ハードウェアの呼び出しへ翻訳する。
//
// StateMachine はハンドシェイクのタイムアウト管理（§3.5の3秒/35秒）を担う
// serial_link::HandshakeTimer を内部に保持する。両者とも純粋ロジックのため、この
// 合成により main.cpp からタイマーの直接操作を排除する（配線の取り違えを防ぐ）。
//
// 時刻は `TimeFunc`（std::function<uint32_t()>）注入で、他モジュールと同方式。
// 経過判定は HandshakeTimer 側で符号なし減算により32bitラップアラウンド安全。
#pragma once

#include <cstddef>
#include <cstdint>

#include "audio_playback.h"
#include "audio_record.h"
#include "button_input.h"
#include "led_controller.h"
#include "serial_link.h"

namespace state_machine {

// 録音LED（赤）を表示するまでの押下保持時間（ミリ秒）。長押し境界（§6）と同一とし、
// 「1.5秒到達＝長押し確定＝会話開始（録音が送信対象になる）」が確定してから赤を点灯する。
// これは録音の kKept/kDiscarded 境界（kMinRecordingSamples=1.5秒）とも一致するため、
// 赤＝「この録音は送信される」の確定表示になる。単押し/ダブル/トリプルの各押下はいずれも
// 1.5秒未満なので、タップで赤が一瞬点く視覚ノイズは構造的に発生しない。録音データの取り込みは
// 押下時点から始まり（1.5秒未満の音声も欠落しない）、遅らせるのは表示のみ（§5-2）。
inline constexpr uint32_t kRecordingLedDelayMs = button_input::kLongPressMs;

// アプリケーションの状態（§5の8演出のうち、待機/録音/考え中/再生と、待機へ復帰する
// 3つの一過性点滅に対応させる）。0x02待ちと考え中は、プロトコル順序とLED開始条件を
// 厳密に守るため別状態とする。
enum class AppState : uint8_t {
    kIdle,           // 待機中（緑ホタル点滅）
    kRecording,      // 録音中（赤点灯）。ボタン押下開始で入る
    kWaitingAccept,  // 0x01送信完了後、0x02を最大3秒待つ（待機LED）
    kThinking,       // 0x02受信後、0x03/0x04を最大35秒待つ（回転スピナー）
    kPlaying,        // 応答再生中（青明滅 or お祝いレインボー）
    kErrorBlink,     // エラー点滅（赤3回）→ 完了後 kIdle
    kDiscardBlink,   // 録音破棄・単押し（黄1回）→ 完了後 kIdle
    kCancelBlink,    // キャンセル受理（マゼンタ2回）→ 完了後 kIdle
};

// 上位層（main.cpp）が実行すべき副作用の集合。1つのイベントで複数が同時に立ち得る
// （例: トリプルクリックは stopPlayback + sendCancel + setLed が同時に立つ）。
// StateMachine 自身はハードウェアへ触れず、この Action を返すだけとし、テスト時は
// 返り値の検証で副作用を確認できるようにする。
struct Action {
    bool startRecording = false;     // マイク録音を開始する（mic.startRecording）
    bool stopRecording = false;      // マイク録音を停止し、結果をStateMachineへ返す
    bool sendRecordedAudio = false;  // 録音データを0x01で送信する
    bool startPlayback = false;      // 直近受信0x03 BODYで再生を開始する
    bool stopPlayback = false;       // 再生を即時停止しバッファをクリアする
    bool sendCancel = false;         // キャンセル通知0x05を送信する
    bool setLed = false;             // LED演出状態を設定する
    led_controller::LedStatus led = led_controller::LedStatus::kIdle;
};

// メイン状態遷移の状態機械（ハードウェア非依存）。
//
// main.cpp は毎ループ、ハードウェアから読んだイベント（ボタンのエッジ／ジェスチャ、
// 受信パケット、録音・再生の進捗、一過性LEDの完了）を対応するメソッドへ与え、返った
// Action をハードウェアの呼び出しへ翻訳する。
class StateMachine {
public:
    using TimeFunc = serial_link::HandshakeTimer::TimeFunc;

    explicit StateMachine(TimeFunc timeFunc);

    AppState state() const { return state_; }

    // ---- ボタン（button_input が算出したエッジ・ジェスチャを与える） ----

    // デバウンス済み押下の false->true エッジ。待機中のみ録音を開始する
    // （待機中以外の押下は §6「待機中以外の単押し・長押しは無視」で無視する）。
    // 赤LEDは即時には出さず、kRecordingLedDelayMs 経過後に poll() が出す（タップの一瞬赤防止）。
    Action onButtonPressDown();

    // デバウンス済み押下の true->false エッジ。録音中のみ停止要求を返す。
    Action onButtonRelease();

    // 確定ジェスチャ。トリプルクリックは全状態で強制リセット、単押しは待機中のみ黄点滅、
    // 長押しは解放エッジ側で録音停止を駆動するためここでは何もしない（§6）。
    Action onButtonGesture(button_input::ButtonGesture gesture);

    // ---- 録音（上位層が recorder.stop() 等の結果を返す） ----

    // 録音停止（解放エッジ or 30秒到達）後、mic.stopRecording() の結果を渡す。
    // kKeptなら0x01送信要求＋0x02待ちへ、kDiscardedなら待機へ、kErrorならエラーへ。
    Action reportRecorderStopped(audio_record::StopResult result);

    // 0x01の物理送信が成功した後に呼び、0x02待ち3秒タイマーを開始する。
    Action onRecordedAudioSent();

    // mic.startRecording() が失敗したとき（マイク初期化・DMA予約失敗）。
    Action onRecorderStartFailed();

    // 0x01 の送信自体に失敗したとき（USB CDC書き込み不整合）。
    Action onSendFailure();

    // ---- 受信コマンド（serial_link のパーサが完成させたパケット） ----

    Action onAcceptReceived(size_t bodySize = 0);              // 0x02（SIZE=0必須）
    Action onPlayReceived(audio_playback::EffectId effectId);  // 0x03
    Action onErrorReceived(size_t bodySize = 0);               // 0x04（SIZE=0必須）

    // ---- 再生（上位層が speaker.loop() の完了・失敗を返す） ----

    Action onPlaybackFinished();  // リング空＋DMA完了で再生完了
    Action onPlaybackError();     // speaker.lastError() が非kNone

    // ---- 一過性LED（led.isTransientFinished() が真になったとき） ----

    Action onTransientFinished();

    // ---- 毎ループのタイムアウト監視（§3.5） ----

    Action poll();

private:
    // 待機へ戻す（ハンドシェイクタイマーもリセットする）。
    Action goIdle();
    // エラー点滅へ遷移する（タイマーをリセットし、点滅完了後に待機復帰する）。
    Action goError();
    // 状態を遷移し、対応するLED設定を含む Action を返す。
    Action enter(AppState next, led_controller::LedStatus led);

    // timer_ より前に宣言する（初期化順序をこの宣言順に合わせるため）。
    TimeFunc timeFunc_;
    AppState state_ = AppState::kIdle;
    serial_link::HandshakeTimer timer_;
    // 録音LEDの遅延表示用（onButtonPressDown で更新し poll で参照する）。
    uint32_t recordStartMs_ = 0;
    bool recordingLedShown_ = false;
};

}  // namespace state_machine
