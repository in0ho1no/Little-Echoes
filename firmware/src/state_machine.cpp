// メイン状態遷移統合の実装（ハードウェア非依存部分）。
#include "state_machine.h"

#include <utility>

namespace state_machine {

using audio_playback::EffectId;
using audio_record::StopResult;
using button_input::ButtonGesture;
using led_controller::LedStatus;
using serial_link::TimeoutEvent;

StateMachine::StateMachine(TimeFunc timeFunc) : timeFunc_(timeFunc), timer_(timeFunc) {}

Action StateMachine::enter(AppState next, LedStatus led) {
    state_ = next;
    Action a;
    a.setLed = true;
    a.led = led;
    return a;
}

Action StateMachine::goIdle() {
    // 待機へ戻るときはハンドシェイクの待ち状態も必ず解除する（誤タイムアウト防止）。
    timer_.reset();
    return enter(AppState::kIdle, LedStatus::kIdle);
}

Action StateMachine::goError() {
    // エラー点滅中はタイマーを止め、点滅完了（onTransientFinished）で待機復帰する。
    timer_.reset();
    return enter(AppState::kErrorBlink, LedStatus::kError);
}

Action StateMachine::onButtonPressDown() {
    // 待機中以外の押下は無視する（考え中・再生中の誤操作で状態を壊さない。§6）。
    if (state_ != AppState::kIdle) {
        return {};
    }
    // 録音データは押下時点から取り込むが、赤LEDは即時に出さない。タップ（単押し/ダブル/
    // トリプルの各押下）で赤が一瞬点くのを避けるため、赤への切り替えは poll() が
    // kRecordingLedDelayMs 経過後に行う。ここでは待機LEDのまま録音を開始する。
    state_ = AppState::kRecording;
    recordStartMs_ = timeFunc_();
    recordingLedShown_ = false;
    Action a;
    a.startRecording = true;
    return a;
}

Action StateMachine::onButtonRelease() {
    // 録音中の解放のみ停止を要求する。停止結果は reportRecorderStopped() で受け取る。
    if (state_ != AppState::kRecording) {
        return {};
    }
    Action a;
    a.stopRecording = true;
    return a;
}

Action StateMachine::onButtonGesture(ButtonGesture gesture) {
    switch (gesture) {
        case ButtonGesture::kTripleClick: {
            // 全状態で強制リセット（§6）。再生中は即時停止、録音中は破棄し、
            // いずれの状態でも 0x05 を送ってからマゼンタ2回点滅で待機復帰する。
            Action a;
            a.sendCancel = true;
            if (state_ == AppState::kPlaying) {
                a.stopPlayback = true;
            }
            if (state_ == AppState::kRecording) {
                // 破棄目的の停止。結果はCancel状態へ遷移済みなので無視される。
                a.stopRecording = true;
            }
            timer_.reset();
            state_ = AppState::kCancelBlink;
            a.setLed = true;
            a.led = LedStatus::kCancelAccepted;
            return a;
        }
        case ButtonGesture::kSinglePress:
            // 単押しは待機中のみ黄点滅（§5-7・§6）。判定窓満了で確定するため、短押しで
            // 開始した録音は解放時に既に kDiscarded で待機へ戻っている前提。
            if (state_ == AppState::kIdle) {
                return enter(AppState::kDiscardBlink, LedStatus::kDiscarded);
            }
            return {};
        case ButtonGesture::kLongPress:
            // 長押しの録音停止＆送信は解放エッジ（onButtonRelease→reportRecorderStopped）で
            // 駆動する。ジェスチャ側では何もしない（録音長の判定はサンプル数を正本とする）。
            return {};
        case ButtonGesture::kNone:
        default:
            return {};
    }
}

Action StateMachine::reportRecorderStopped(StopResult result) {
    // トリプルクリック等で録音状態を抜けた後に遅れて呼ばれても、状態を巻き戻さない。
    if (state_ != AppState::kRecording) {
        return {};
    }
    switch (result) {
        case StopResult::kKept: {
            // 送信時間を3秒待ちへ含めないため、タイマー開始は送信成功報告まで遅延する。
            Action a = enter(AppState::kWaitingAccept, LedStatus::kIdle);
            a.sendRecordedAudio = true;
            return a;
        }
        case StopResult::kDiscarded:
            // 最短録音長未満。黄点滅は単押しジェスチャ確定（kSinglePress）で表示するため、
            // ここでは無音で待機へ戻す（§6の「黄点滅は判定窓確定後に表示」）。
            return goIdle();
        case StopResult::kError:
        default:
            return goError();
    }
}

Action StateMachine::onRecordedAudioSent() {
    if (state_ != AppState::kWaitingAccept) {
        return {};
    }
    timer_.onRecordedAudioSent();
    return {};
}

Action StateMachine::onRecorderStartFailed() {
    if (state_ != AppState::kRecording) {
        return {};
    }
    return goError();
}

Action StateMachine::onSendFailure() {
    if (state_ != AppState::kWaitingAccept) {
        return {};
    }
    return goError();
}

Action StateMachine::onAcceptReceived(size_t bodySize) {
    if (state_ != AppState::kWaitingAccept || bodySize != 0) {
        return {};
    }
    // 期限ちょうど／超過で届いた 0x02 はタイムアウト扱い（HandshakeTimer が判定）。
    // 通常 poll() が先にタイムアウトを検知するが、同時到着の取りこぼしを防ぐ。
    if (timer_.onAcceptReceived() != TimeoutEvent::kNone) {
        return goError();
    }
    return enter(AppState::kThinking, LedStatus::kThinking);
}

Action StateMachine::onPlayReceived(EffectId effectId) {
    if (state_ != AppState::kThinking) {
        return {};
    }
    if (timer_.onResponseReceived() != TimeoutEvent::kNone) {
        return goError();
    }
    const LedStatus led =
        effectId == EffectId::kCelebration ? LedStatus::kCelebration : LedStatus::kPlaying;
    Action a = enter(AppState::kPlaying, led);
    a.startPlayback = true;
    return a;
}

Action StateMachine::onErrorReceived(size_t bodySize) {
    // 0x04（エラー通知）。考え中でのみ受理し、エラー表示ののち待機へ復帰する（§3.5）。
    if (state_ != AppState::kThinking || bodySize != 0) {
        return {};
    }
    timer_.onResponseReceived();
    return goError();
}

Action StateMachine::onPlaybackFinished() {
    if (state_ != AppState::kPlaying) {
        return {};
    }
    return goIdle();
}

Action StateMachine::onPlaybackError() {
    if (state_ != AppState::kPlaying) {
        return {};
    }
    return goError();
}

Action StateMachine::onTransientFinished() {
    // エラー/破棄/キャンセルの点滅が終わったら待機へ復帰する（§5）。
    switch (state_) {
        case AppState::kErrorBlink:
        case AppState::kDiscardBlink:
        case AppState::kCancelBlink:
            return goIdle();
        default:
            return {};
    }
}

Action StateMachine::poll() {
    // 0x02待ちまたは考え中だけ、3秒/35秒タイムアウトでエラーへ遷移する。
    const TimeoutEvent event = timer_.poll();
    if (event != TimeoutEvent::kNone &&
        (state_ == AppState::kWaitingAccept || state_ == AppState::kThinking)) {
        return goError();
    }
    // 押下が長押し境界（1.5秒＝会話開始確定）に達したら赤LEDへ切り替える。1.5秒未満で離す
    // タップ（単押し/ダブル/トリプルの各押下）では赤を出さない。一度出したら同じ録音では
    // 繰り返さない。経過は符号なし減算で32bitラップアラウンド安全。
    if (state_ == AppState::kRecording && !recordingLedShown_ &&
        static_cast<uint32_t>(timeFunc_() - recordStartMs_) >= kRecordingLedDelayMs) {
        recordingLedShown_ = true;
        Action a;
        a.setLed = true;
        a.led = LedStatus::kRecording;
        return a;
    }
    return {};
}

}  // namespace state_machine
