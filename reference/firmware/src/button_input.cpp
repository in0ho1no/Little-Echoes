// ボタン入力（デバウンス・クリック判定）の実装。docs/SPEC.md §6 に基づく。
#include "button_input.h"

#include <utility>

namespace button_input {

ButtonInput::ButtonInput(TimeFunc timeFunc) : timeFunc_(std::move(timeFunc)) {}

ButtonInput::Edge ButtonInput::debounce(bool rawPressed, uint32_t now) {
    if (rawPressed != candidateLevel_) {
        // 生の状態が変わった。まだ確定はせず、安定タイマーをリスタートする。
        candidateLevel_ = rawPressed;
        candidateSinceMs_ = now;
        return Edge::kNone;
    }
    if (candidateLevel_ == debouncedPressed_) {
        // 候補は確定済みの状態と同じ。変化なし。
        return Edge::kNone;
    }
    // 候補が確定状態と異なる。安定時間を満たしたら確定する。
    // 経過は符号なし減算で求め、millis()の32bitラップアラウンドをまたいでも正しく判定する。
    if (now - candidateSinceMs_ >= kDebounceMs) {
        debouncedPressed_ = candidateLevel_;
        return debouncedPressed_ ? Edge::kPressDown : Edge::kRelease;
    }
    return Edge::kNone;
}

ButtonGesture ButtonInput::update(bool rawPressed) {
    const uint32_t now = timeFunc_();
    const Edge edge = debounce(rawPressed, now);

    switch (edge) {
        case Edge::kPressDown:
            return onPressDown(now);
        case Edge::kRelease:
            return onRelease(now);
        case Edge::kNone:
        default:
            // エッジが無い間も、判定窓の満了を検知する必要がある。
            return pollWindow(now);
    }
}

ButtonGesture ButtonInput::onPressDown(uint32_t now) {
    if (!seqActive_) {
        // 新しいシーケンスの初回押下。窓の基点をここに置く。
        seqActive_ = true;
        firstPressMs_ = now;
        clickCount_ = 0;
    } else if (now - firstPressMs_ >= kMultiClickWindowMs) {
        // 直前シーケンスの窓は既に満了しているはず（通常は解放中の pollWindow で
        // 確定済み）。ここに来るのは想定外だが、確実に新シーケンスとして扱う。
        // 人間のクリック間隔（>80ms）とデバウンス（40ms）に対し update 周期は十分短く、
        // 解放中に pollWindow が走らないことは実質起こらないため、防御的措置。
        seqActive_ = true;
        firstPressMs_ = now;
        clickCount_ = 0;
    }
    pressDownMs_ = now;

    // 窓内の3回目の押下ならトリプルクリックを即時確定する（解放を待たない。§6）。
    if (clickCount_ + 1 == 3 && now - firstPressMs_ < kMultiClickWindowMs) {
        resetSequence();
        swallowNextRelease_ = true;  // この押下の解放は新クリックとして数えない
        return ButtonGesture::kTripleClick;
    }
    return ButtonGesture::kNone;
}

ButtonGesture ButtonInput::onRelease(uint32_t now) {
    if (swallowNextRelease_) {
        // トリプルクリック確定時の3回目押下に対応する解放。読み捨てる。
        swallowNextRelease_ = false;
        return ButtonGesture::kNone;
    }
    if (!seqActive_) {
        // シーケンス外の解放（起動直後など）。無視する。
        return ButtonGesture::kNone;
    }

    const uint32_t heldMs = now - pressDownMs_;
    if (heldMs >= kLongPressMs) {
        // 長押し。1回で確定し、マルチクリックには数えない（§6）。
        resetSequence();
        return ButtonGesture::kLongPress;
    }

    // 短押し（クリック）。
    ++clickCount_;
    if (now - firstPressMs_ >= kMultiClickWindowMs) {
        // 既に窓が満了している（初回押下を窓超えまで保持してから短く解放した等）。
        // これ以上クリックは受け付けないので、ここで単押し（1〜2回）を確定する。
        resetSequence();
        return ButtonGesture::kSinglePress;
    }
    // 窓内。後続クリックまたは窓満了を待つ。
    return ButtonGesture::kNone;
}

ButtonGesture ButtonInput::pollWindow(uint32_t now) {
    // 判定窓の満了は、ボタンが離れている間のみ確定する。押下中に窓が満了した場合は
    // 解放まで待ち、保持時間で長押し/短押しを判定する（onRelease）。
    if (!seqActive_ || debouncedPressed_) {
        return ButtonGesture::kNone;
    }
    if (now - firstPressMs_ >= kMultiClickWindowMs) {
        if (clickCount_ == 0) {
            // 解放を伴わずに窓が満了することは通常起きない（防御的にリセットのみ）。
            resetSequence();
            return ButtonGesture::kNone;
        }
        // clickCount_ は 1 または 2（3ならトリプルとして押下時に確定済み）。単押し確定。
        resetSequence();
        return ButtonGesture::kSinglePress;
    }
    return ButtonGesture::kNone;
}

void ButtonInput::resetSequence() {
    seqActive_ = false;
    firstPressMs_ = 0;
    pressDownMs_ = 0;
    clickCount_ = 0;
}

}  // namespace button_input
