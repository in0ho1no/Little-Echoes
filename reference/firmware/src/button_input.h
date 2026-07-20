// ボタン入力（デバウンス・クリック判定）。docs/SPEC.md §6 に基づく。
//
// G41ボタンの生の押下状態を毎ループ `update()` に与えると、ソフトウェアデバウンスを
// 行ったうえで以下のジェスチャを判定して返す:
//   - 単押し（1〜2回・1.5秒未満で解放）: kSinglePress（何もしない＋黄点滅は上位層）
//   - 長押し（1.5秒以上保持して解放）  : kLongPress（録音終了＆送信は上位層）
//   - トリプルクリック（初回押下から1.2秒の絶対窓内に3回押下）: kTripleClick（強制リセット）
//
// 本モジュールはハードウェア非依存の純粋な検出器で、時刻は `TimeFunc` 注入
// （packet.h / serial_link.h と同方式）。GPIO読み取り（アクティブロー変換）と、
// 「待機中以外の単押し・長押しは無視」等のアプリ状態依存のフィルタリングは
// 上位層（task7）の責務とする。トリプルクリックのみ全状態で有効という規則も
// 上位層側でハンドリングする（本モジュールは状態に関わらず検出して返すだけ）。
#pragma once

#include <cstdint>
#include <functional>

namespace button_input {

// ソフトウェアデバウンス時間（§6: 30〜50ms）
inline constexpr uint32_t kDebounceMs = 40;
// 単押し/長押しの境界（§6: 1.5秒。§4.1の最短録音長と同一値。録音側の定数は
// task5で定義し、両者が一致していることを実装時に確認する）
inline constexpr uint32_t kLongPressMs = 1500;
// マルチクリック判定窓（§6: 初回押下から1.2秒の絶対窓。押下ごとの延長なし）
inline constexpr uint32_t kMultiClickWindowMs = 1200;

enum class ButtonGesture {
    kNone,
    kSinglePress,  // 1〜2回の短押しが窓満了で確定（§6: 何もしない）
    kLongPress,    // 1.5秒以上保持して解放（§6: 録音終了＆送信）
    kTripleClick,  // 窓内に3回目の押下を検出（§6: 強制リセット。3回目押下で即時確定）
};

// ボタンのクリック判定ステートマシン（ハードウェア非依存）。
class ButtonInput {
public:
    // ミリ秒単位の単調増加時刻を返す関数（実機では millis を渡す）。テスト時は差し替え可能。
    using TimeFunc = std::function<uint32_t()>;

    explicit ButtonInput(TimeFunc timeFunc);

    // 毎ループ、ボタンの生の押下状態を与えて呼ぶ。
    //
    // rawPressed: 物理的に押されていれば true（アクティブロー変換は呼び出し側で行う）。
    //
    // 戻り値: 確定したジェスチャ（1回の呼び出しで最大1個）。未確定なら kNone。
    //   - kTripleClick は3回目の押下エッジで即時に返る（解放を待たない）。
    //   - kLongPress は1.5秒以上保持後の解放エッジで返る。
    //   - kSinglePress は判定窓（1.2秒）満了時に返る。押下時点では後続クリックの有無が
    //     未確定なため、確定は窓満了まで遅延する（§6の黄点滅フィードバックの遅延と対応）。
    ButtonGesture update(bool rawPressed);

    // デバウンス済みの押下状態。上位層が録音開始/停止やLED「録音中」表示に使う。
    bool isPressed() const { return debouncedPressed_; }

private:
    enum class Edge { kNone, kPressDown, kRelease };

    // デバウンス処理。今回の update でデバウンス済み状態が変化したらそのエッジを返す。
    Edge debounce(bool rawPressed, uint32_t now);
    ButtonGesture onPressDown(uint32_t now);
    ButtonGesture onRelease(uint32_t now);
    ButtonGesture pollWindow(uint32_t now);
    void resetSequence();

    TimeFunc timeFunc_;

    // デバウンス
    bool candidateLevel_ = false;
    uint32_t candidateSinceMs_ = 0;
    bool debouncedPressed_ = false;

    // クリック判定シーケンス
    bool seqActive_ = false;       // 判定窓が進行中（初回押下済み）
    uint32_t firstPressMs_ = 0;    // シーケンス初回押下の時刻（窓の基点）
    uint32_t pressDownMs_ = 0;     // 現在の押下開始時刻（保持時間の基点）
    uint8_t clickCount_ = 0;       // 確定済みの短クリック数（解放でインクリメント）
    bool swallowNextRelease_ = false;  // トリプルクリック確定後、その解放を無視する
};

}  // namespace button_input
