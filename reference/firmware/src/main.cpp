// タスク7: メイン状態遷移統合。docs/SPEC.md アプリ処理フロー（マイコン側）に基づく。
//
// task2〜6で実装した各モジュール（serial_link/button_input/led_controller/
// audio_record/audio_playback）を配線し、待機→録音→0x01送信→考え中→再生/エラー→待機
// の一連の遷移を state_machine::StateMachine で統合する。StateMachine は状態遷移の中核
// （ハードウェア非依存）で native テスト済み。main.cpp はハードウェアI/Oと StateMachine の
// 橋渡しに徹し、StateMachine が返す Action を実ハードウェアの呼び出しへ翻訳する。
//
// 設計上の注意（docs/task_マイコン.md 申し送り）:
//   - BODY受信中もPC側の送信を停滞させないよう、loop() はブロックしない。
//   - トリプルクリックは全状態で最優先の強制リセット。ジェスチャを押下エッジより先に
//     処理することで、3回目の押下で録音を開始してしまわないようにする。
#include <M5Unified.h>

#include <vector>

#include "audio_playback.h"
#include "audio_record.h"
#include "button_input.h"
#include "led_controller.h"
#include "packet.h"
#include "serial_link.h"
#include "state_machine.h"

namespace {

// millis() を各モジュールの TimeFunc（uint32_t()）へ渡すためのアダプタ。
uint32_t nowMs() { return static_cast<uint32_t>(millis()); }

// Atom EchoS3R のユーザーボタン（G41、アクティブロー。押下でGND）。
constexpr uint8_t kButtonPin = 41;

// 起動（再起動）の目安に鳴らす短い起動音。びっくりしないよう控えめな音量・短さにする
// （再生用の kSpeakerVolume とは別。鳴らし終えたら再生用音量へ戻す）。実測に応じて調整可能。
constexpr uint8_t kBootToneVolume = 50;    // 0〜255（≈20%）
constexpr uint16_t kBootToneFreqHz = 880;  // A5。1kHzより耳に優しい
constexpr uint32_t kBootToneMs = 1000;     // 約1秒（再起動に気づける長さ）

// 診断パケット（デバッグ用・SPEC外）。エラー遷移や想定外イベントの発生時に、理由コードと
// 詳細値をPC側へ通知する。PC側 pipeline.py は 0x7F を解読して警告ログに出す（それ以外の
// PC実装では未知cmdとして読み捨てられるだけで、プロトコル動作に影響しない）。
// task8のE2Eで「PC側ログは正常なのにマイコンがエラー点滅する」間欠事象が発生したため、
// 次の再現時にマイコン側の失敗経路を一発で特定できるようにする。
constexpr uint8_t kDiagCommand = 0x7F;

// ダウンロードモード再起動コマンド（デバッグ用・SPEC外）。MODE=0はesptoolの自動リセットが
// 効かないため、PCから受信したらROMブートローダーへ再起動して遠隔書き込みを可能にする。
// 誤発動防止のためBODYは空を必須とする。
constexpr uint8_t kRebootCommand = 0x7D;

// 疑似ボタン押下コマンド（デバッグ用・SPEC外）。BODY=4B LEの押下保持ミリ秒。
// 受信すると押下エッジを注入し、保持時間経過後に解放エッジを注入する。実マイク録音・
// LED・送信・状態遷移まで本物のボタン操作と同一のフローが走るため、task8のUSB停止問題を
// 人手なしで反復再現するのに使う（相手: scripts/task7_fw_probe.py の --auto-press）。
constexpr uint8_t kFakePressCommand = 0x7C;
enum class DiagReason : uint8_t {
    kSendRecordedAudioFailed = 0x01,  // 0x01送信失敗（detail=録音バイト数）
    kRecorderStartFailed = 0x02,      // 録音開始失敗（detail=MicRecorderのlastError）
    kRecorderStopError = 0x03,        // 録音停止結果がkError（detail=lastError）
    kPlaybackStartFailed = 0x04,      // startResponse失敗（detail=SpeakerPlayerのlastError）
    kPlaybackLoopError = 0x05,        // 再生中のloop()失敗（detail=lastError）
    kAcceptTimeout = 0x06,            // 0x02待ち3秒タイムアウト（detail=0）
    kResponseTimeout = 0x07,          // 0x03/0x04待ち35秒タイムアウト（detail=0）
    kRxRingDropped = 0x08,            // 受信リング満杯での読み捨て（detail=累計バイト数）
    kPlayIgnored = 0x09,              // 考え中以外で0x03受信（detail=そのときのAppState）
    kAcceptIgnored = 0x0A,            // 0x02待ち以外で0x02受信（detail=そのときのAppState）
};

led_controller::LedController g_led(nowMs);
button_input::ButtonInput g_button(nowMs);
audio_record::MicRecorder g_mic;
audio_playback::SpeakerPlayer g_speaker;
transport::PacketParser g_parser(nowMs);
state_machine::StateMachine g_sm(nowMs);

bool g_wasPressed = false;
bool g_startupFailed = false;
std::vector<transport::Packet> g_packets;
uint32_t g_reportedRxDropped = 0;

// 疑似ボタン押下（kFakePressCommand）の解放予約。
bool g_fakePressActive = false;
uint32_t g_fakePressStartMs = 0;
uint32_t g_fakePressHoldMs = 0;

// 診断パケットを送信する（fire-and-forget。送信失敗しても本処理へ影響させない）。
// BODY: [reason:1][detail:4 LE]
void sendDiag(DiagReason reason, uint32_t detail) {
    uint8_t body[5];
    body[0] = static_cast<uint8_t>(reason);
    body[1] = static_cast<uint8_t>(detail & 0xFF);
    body[2] = static_cast<uint8_t>((detail >> 8) & 0xFF);
    body[3] = static_cast<uint8_t>((detail >> 16) & 0xFF);
    body[4] = static_cast<uint8_t>((detail >> 24) & 0xFF);
    serial_link::sendPacket(kDiagCommand, body, sizeof(body));
}

// StateMachine が返した Action を実ハードウェアの呼び出しへ翻訳する。
// 録音停止・送信失敗・録音開始失敗は再帰的に StateMachine へ結果を返す（自己再帰）。
// 再生開始（startPlayback）はBODYを要するため呼び出し側で個別に処理する。
void apply(const state_machine::Action& action) {
    if (action.setLed) {
        g_led.setStatus(action.led);
    }
    if (action.startRecording) {
        if (!g_mic.startRecording()) {
            sendDiag(DiagReason::kRecorderStartFailed, static_cast<uint32_t>(g_mic.lastError()));
            apply(g_sm.onRecorderStartFailed());
        }
    }
    if (action.stopRecording) {
        // 30秒到達でも解放でも、実際の停止と末尾チャンク取り込みはここで行う。
        const audio_record::StopResult result = g_mic.stopRecording();
        if (result == audio_record::StopResult::kError) {
            sendDiag(DiagReason::kRecorderStopError, static_cast<uint32_t>(g_mic.lastError()));
        }
        apply(g_sm.reportRecorderStopped(result));
    }
    if (action.sendRecordedAudio) {
        // 録音は int16 サンプル列。0x01 BODY はLE PCM RAW（§4）なのでバイト列として送る。
        // ESP32はリトルエンディアンのため int16 のメモリ表現がそのままLE PCMとなる。
        const auto* pcm = reinterpret_cast<const uint8_t*>(g_mic.data());
        if (!serial_link::sendPacket(static_cast<uint8_t>(transport::Command::kRecordedAudio), pcm,
                                     g_mic.sizeBytes())) {
            sendDiag(DiagReason::kSendRecordedAudioFailed, static_cast<uint32_t>(g_mic.sizeBytes()));
            apply(g_sm.onSendFailure());
        } else {
            apply(g_sm.onRecordedAudioSent());
        }
    }
    if (action.stopPlayback) {
        g_speaker.stop();
    }
    if (action.sendCancel) {
        serial_link::sendPacket(static_cast<uint8_t>(transport::Command::kCancel), nullptr, 0);
    }
}

// 受信した1パケットを StateMachine へ配送する。0x03 は再生開始にBODYが要るため個別処理。
void dispatchPacket(const transport::Packet& pkt) {
    switch (static_cast<transport::Command>(pkt.cmd)) {
        case transport::Command::kAcceptProcessing:  // 0x02
            if (g_sm.state() != state_machine::AppState::kWaitingAccept) {
                sendDiag(DiagReason::kAcceptIgnored, static_cast<uint32_t>(g_sm.state()));
            }
            apply(g_sm.onAcceptReceived(pkt.body.size()));
            break;
        case transport::Command::kPlayAudio: {  // 0x03
            if (g_sm.state() != state_machine::AppState::kThinking) {
                sendDiag(DiagReason::kPlayIgnored, static_cast<uint32_t>(g_sm.state()));
            }
            const audio_playback::PlaybackBody parsed =
                audio_playback::parsePlaybackBody(pkt.body.data(), pkt.body.size());
            const audio_playback::EffectId effectId =
                parsed.valid ? parsed.effectId : audio_playback::EffectId::kNormal;
            const state_machine::Action action = g_sm.onPlayReceived(effectId);
            apply(action);
            if (action.startPlayback) {
                if (!g_speaker.startResponse(pkt.body.data(), pkt.body.size())) {
                    sendDiag(DiagReason::kPlaybackStartFailed, static_cast<uint32_t>(g_speaker.lastError()));
                    apply(g_sm.onPlaybackError());
                }
            }
            break;
        }
        case transport::Command::kError:  // 0x04
            apply(g_sm.onErrorReceived(pkt.body.size()));
            break;
        default:
            if (pkt.cmd == kRebootCommand && pkt.body.empty()) {
                serial_link::rebootToBootloader();  // 戻らない
            }
            if (pkt.cmd == kFakePressCommand && pkt.body.size() == 4 && !g_fakePressActive) {
                g_fakePressHoldMs = static_cast<uint32_t>(pkt.body[0]) |
                                    (static_cast<uint32_t>(pkt.body[1]) << 8) |
                                    (static_cast<uint32_t>(pkt.body[2]) << 16) |
                                    (static_cast<uint32_t>(pkt.body[3]) << 24);
                g_fakePressStartMs = millis();
                g_fakePressActive = true;
                apply(g_sm.onButtonPressDown());
            }
            // 0x01/0x05/0x06 はマイコン→PC方向。受信しても無視する。
            break;
    }
}

}  // namespace

void setup() {
    auto cfg = M5.config();
    // ARDUINO_USB_CDC_ON_BOOT=0のためSerialはUART0を指す。M5UnifiedにSerial.begin()させず、
    // 使わないUART0を起動しない（USB CDCはserial_link独自ドライバが担う）。
    cfg.serial_baudrate = 0;
    M5.begin(cfg);
    pinMode(kButtonPin, INPUT_PULLUP);

    g_led.begin();
    g_led.setStatus(led_controller::LedStatus::kIdle);

    // 通信初期化に失敗した状態でREADYを送ると、PCからは接続済みに見えて受信だけできない
    // 故障になる。以降の初期化を止め、loop()でエラー表示を繰り返す。
    if (!serial_link::begin()) {
        g_startupFailed = true;
        g_led.setStatus(led_controller::LedStatus::kError);
        return;
    }

    // PSRAMバッファ確保＋コーデック設定。ここで失敗しても起動は継続し、録音/再生の要求時に
    // startRecording()/startResponse() が false を返すことでエラー表示として表面化する。
    g_mic.begin();
    g_speaker.begin();

    // 起動（再起動）の目安として、控えめな音量で短い起動音を鳴らす。再生音量とは別の低めの
    // 音量を使い、鳴らし終えたら再生用音量へ戻す（再生が小さくならないように）。あわせて実機で
    // M5.Speakerの実音出力が生きていることの確認にもなる。
    M5.Speaker.begin();
    M5.Speaker.setVolume(kBootToneVolume);
    M5.Speaker.tone(kBootToneFreqHz, kBootToneMs);
    delay(kBootToneMs + 100);
    M5.Speaker.end();
    M5.Speaker.setVolume(audio_playback::kSpeakerVolume);  // 再生用の音量へ戻す

    // 起動完了。READY(0x06)を送信してPCへリンク確立を通知する（§3.4）。
    serial_link::sendReady();
}

void loop() {
    if (g_startupFailed) {
        // 一過性エラー点滅が終わったら再度開始し、電源再投入が必要な起動異常を表示し続ける。
        if (g_led.isTransientFinished()) {
            g_led.setStatus(led_controller::LedStatus::kError);
        }
        g_led.loop();
        delay(1);
        return;
    }

    const bool rawPressed = (digitalRead(kButtonPin) == LOW);  // アクティブロー変換

    // 1. ボタン: ジェスチャを押下エッジより先に処理する。トリプルクリック（3回目の押下で
    //    即時確定）を強制リセットとして優先し、その押下で録音を開始しないようにする（§6）。
    const button_input::ButtonGesture gesture = g_button.update(rawPressed);
    if (gesture != button_input::ButtonGesture::kNone) {
        apply(g_sm.onButtonGesture(gesture));
    }
    const bool pressed = g_button.isPressed();
    if (pressed && !g_wasPressed) {
        apply(g_sm.onButtonPressDown());
    } else if (!pressed && g_wasPressed) {
        apply(g_sm.onButtonRelease());
    }
    g_wasPressed = pressed;

    // 疑似ボタン押下（0x7C）の解放。保持時間が経過したら解放エッジを注入する。
    if (g_fakePressActive && millis() - g_fakePressStartMs >= g_fakePressHoldMs) {
        g_fakePressActive = false;
        apply(g_sm.onButtonRelease());
    }

    // 2. 受信パケット処理（BODY受信中もここで読み続け、PC側送信を停滞させない）。
    g_packets.clear();
    serial_link::pumpIncoming(g_parser, g_packets);
    for (const auto& pkt : g_packets) {
        dispatchPacket(pkt);
    }
    // 大きなBODY（最大約1.44MBの0x03音声）を受信中は、NeoPixelのshow()でCPUが奪われて
    // USB受信を取りこぼす可能性を避けるため、この後のLED更新をスキップし受信を優先する。
    // 受信完了後の次ループで演出を再開する（考え中スピナーが一時的に止まる）。
    const bool receivingBody = g_parser.isReceivingBody();

    // 3. ハンドシェイクのタイムアウト監視（§3.5: 0x02待ち3秒 / 0x03·0x04待ち35秒）。
    //    poll()前後の状態比較でどちらのタイムアウトが発火したかを判別し、診断で通知する。
    const state_machine::AppState stateBeforePoll = g_sm.state();
    apply(g_sm.poll());
    if (g_sm.state() == state_machine::AppState::kErrorBlink &&
        stateBeforePoll != state_machine::AppState::kErrorBlink) {
        if (stateBeforePoll == state_machine::AppState::kWaitingAccept) {
            sendDiag(DiagReason::kAcceptTimeout, 0);
        } else if (stateBeforePoll == state_machine::AppState::kThinking) {
            sendDiag(DiagReason::kResponseTimeout, 0);
        }
    }

    // 受信リング満杯での読み捨て（発生しない想定の安全弁）が起きていたら通知する。
    const uint32_t rxDropped = serial_link::rxDroppedBytes();
    if (rxDropped != g_reportedRxDropped) {
        g_reportedRxDropped = rxDropped;
        sendDiag(DiagReason::kRxRingDropped, rxDropped);
    }

    // 4. 現在状態のハードウェア駆動。
    switch (g_sm.state()) {
        case state_machine::AppState::kRecording:
            // 録音中は毎ループDMAチャンクを取り込む。false は30秒到達での自動停止。
            if (!g_mic.loop()) {
                apply(g_sm.reportRecorderStopped(g_mic.stopRecording()));
            }
            break;
        case state_machine::AppState::kPlaying:
            // 再生中は毎ループリングバッファをスピーカーへ供給する。false は再生完了 or 失敗。
            if (!g_speaker.loop()) {
                if (g_speaker.lastError() != audio_playback::PlaybackError::kNone) {
                    sendDiag(DiagReason::kPlaybackLoopError, static_cast<uint32_t>(g_speaker.lastError()));
                    apply(g_sm.onPlaybackError());
                } else {
                    apply(g_sm.onPlaybackFinished());
                }
            }
            break;
        case state_machine::AppState::kErrorBlink:
        case state_machine::AppState::kDiscardBlink:
        case state_machine::AppState::kCancelBlink:
            // 一過性点滅が所定回数終わったら待機へ復帰する（§5）。
            if (g_led.isTransientFinished()) {
                apply(g_sm.onTransientFinished());
            }
            break;
        default:
            break;
    }

    // 5. LED更新（LedAnimator が最大50fpsへ自律制限。上の状態変更は同ループで即反映される）。
    //    大きなBODY受信中はスキップし、受信完了後に再開する（NeoPixel show()による取りこぼし防止。
    //    上記2参照）。
    if (!receivingBody) {
        g_led.loop();
    }

    // ループをタイトに回し続けるとTinyUSBの受信タスク等の下位タスクが枯渇し、USB CDCの
    // host→device受信スループットが著しく落ちる。1ms yieldして下位タスクへCPUを回す
    // （ボタン40ms・LED20ms・I2S DMA約21ms周期に対し1msの粒度は十分細かく実害なし）。
    delay(1);
}
