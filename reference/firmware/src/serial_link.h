// シリアル通信層・接続ハンドシェイク。
//
// PC側との `0x01` 送信後の `0x02` 待ち（3秒）、`0x02` 受信後の `0x03`/`0x04` 待ち
// （35秒）のタイムアウト管理（docs/SPEC.md §3.5）と、USB CDC初期化・READY送信・
// パケット送受信の薄いラッパーを提供する。
//
// HandshakeTimerはハードウェア非依存（時刻注入可能）で、PlatformIO native環境の
// ホスト側ユニットテスト対象。begin()等の実シリアルI/Oを伴う関数群は、Arduino
// フレームワークビルド時にのみ定義され（ARDUINOマクロで判定）、実機での動作確認が
// 必要（PC側なしでの起動、PC側ダミースクリプトとの疎通）。
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

#include "packet.h"

namespace serial_link {

// `0x01` 送信後、`0x02` を待つ時間（§3.5）
inline constexpr uint32_t kAcceptTimeoutMs = 3000;
// `0x02` 受信後、`0x03`/`0x04` を待つ時間（§3.5）
inline constexpr uint32_t kResponseTimeoutMs = 35000;

enum class TimeoutEvent {
    kNone,
    kAcceptTimeout,    // 0x02が来ないまま3秒経過
    kResponseTimeout,  // 0x03/0x04が来ないまま35秒経過
};

// ハンドシェイク・タイムアウト管理の状態機械（ハードウェア非依存）。
// シリアル送受信そのものは行わず、呼び出し側が送受信イベントを通知する。
class HandshakeTimer {
public:
    // ミリ秒単位の単調増加時刻を返す関数（実機では millis を渡す）。
    // テスト時は差し替え可能。
    using TimeFunc = std::function<uint32_t()>;

    explicit HandshakeTimer(TimeFunc timeFunc);

    // 0x01（録音データ）送信直後に呼ぶ。0x02待ちタイマーを開始する。
    void onRecordedAudioSent();

    // 0x02（受理）受信時に呼ぶ。受信時点で期限切れならタイムアウトを返して待機状態へ戻る。
    // 0x02待ち中でなければ無視してkNoneを返す。
    TimeoutEvent onAcceptReceived();

    // 0x03（再生）または0x04（エラー）受信時に呼ぶ。受信時点で期限切れなら
    // タイムアウトを返して待機状態へ戻る。0x03/0x04待ち中でなければkNoneを返す。
    TimeoutEvent onResponseReceived();

    // トリプルクリック強制リセット等で待機状態へ戻す。
    void reset();

    // 定期的に呼び出し、タイムアウトを検知する。タイムアウト時は待機状態へ戻る。
    TimeoutEvent poll();

private:
    enum class State {
        kIdle,
        kWaitingAccept,
        kWaitingResponse,
    };

    State state_ = State::kIdle;
    TimeFunc timeFunc_;
    uint32_t waitStartMs_ = 0;
};

#ifdef ARDUINO

// USB CDC（USB-OTG/TinyUSB）を初期化し列挙を開始する。
//
// コアのUSBCDCクラス（Serial）は受信を1バイトずつFreeRTOSキューへ通すため約44KB/sで
// 頭打ちになる（docs/issue_usb_throughput.md）。ここではCDCインターフェースを自前登録し、
// TinyUSBのFIFOから一括読みする独自ドライバを使う（ARDUINO_USB_CDC_ON_BOOT=0が前提。
// Serialを参照するとUSBCDC.oのコールバック定義と衝突するため、本モジュール以外でも
// Serialは使用しないこと）。受信バッファ確保・CDC登録・USB開始のいずれかに失敗した場合は
// falseを返す。失敗後は受信不能なので、呼び出し側はREADYを送らず起動エラーとして扱うこと。
bool begin();

// READY（0x06、SIZE=0）を送信する。
bool sendReady();

// 任意のパケットを送信する。bodySizeが0の場合bodyはnullptrでもよい。
// ホスト未接続（DTR未確立）時や送信進捗が1秒停止した場合はfalseを返す。
bool sendPacket(uint8_t cmd, const uint8_t* body, size_t bodySize);

// 受信リングに溜まったバイト列をparserへ投入し、完成したパケットをoutPacketsへ追記する。
// あわせてホストのポートオープン（DTR立ち上がり）を検知したらREADYを再送する（§3.4。
// 起動時のREADYはホスト不在で失われるため）。呼び出し側は毎ループ呼ぶこと
// （docs/task_マイコン.md 申し送り事項）。
void pumpIncoming(transport::PacketParser& parser, std::vector<transport::Packet>& outPackets);

// 受信リング満杯で読み捨てたバイト数の累計（物理的に起きない想定の安全弁の計数）。
// 診断パケット（main.cppのkDiagRxDropped）でPC側へ報告するために公開する。
uint32_t rxDroppedBytes();

// ROMブートローダー（ダウンロードモード）へ再起動する。呼ぶと戻らない。
// MODE=0（USB-OTG）はesptoolの自動リセットでダウンロードモードへ入れないため、
// PCからのコマンド（0x7D）で遠隔書き込みを可能にする（task8で導入。物理ボタン不要化）。
void rebootToBootloader();

#endif  // ARDUINO

}  // namespace serial_link
