// パケット構造（同期マーカー＋ヘッダ＋ボディ方式）のエンコード・デコード。
// PC側 src/transport/packet.py（正本）のC++移植。docs/SPEC.md §3.2, §3.3 に基づく。
//
// パケット構造:
//     SYNC (2byte, 固定値 0xA5 0x5A) + CMD (1byte) + SIZE (4byte, ビッグエンディアン)
//     + BODY (可変長)
//
// 受信側の堅牢性ルール:
//     1. 受信パーサは常に SYNC を探索して読み捨て再同期する。
//     2. SIZE上限は 2MB。超過時は不正パケットとみなしパーサをリセットして再同期する。
//     3. BODY待ちの間、新しいデータが kBodyTimeoutMs 届かない場合はパケットを破棄し
//        パーサをリセットする（§3.2 v1.3.2: 停滞した送信元の検知が目的。大きなBODYが
//        遅いリンクで合計 kBodyTimeoutMs 超をかけて届くこと自体は正常として扱う）。
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace transport {

// 同期マーカー（固定値 0xA5 0x5A）
inline constexpr uint8_t kSync[2] = {0xA5, 0x5A};
// SYNC(2) + CMD(1) + SIZE(4)
inline constexpr size_t kHeaderSize = 7;
// SIZE上限 2MB (2,097,152バイト)
inline constexpr uint32_t kMaxBodySize = 2 * 1024 * 1024;
// BODY受信の無進捗タイムアウト（PC側 BODY_TIMEOUT_SEC = 5.0 に対応。§3.2 v1.3.2）。
// 「ヘッダ受信後この時間内にBODY全体」ではなく「新しいデータがこの時間届かない」場合の破棄。
// 大きなBODY（最大2MB）が遅いリンクで5秒超をかけて届くのは正常であり、停滞のみを検知する。
inline constexpr uint32_t kBodyTimeoutMs = 5000;

// CMD（制御命令）の定義。docs/SPEC.md §3.3 参照。
enum class Command : uint8_t {
    kRecordedAudio = 0x01,    // マイコン→PC: 録音音声データ送信（ボタン長押し終了時）
    kAcceptProcessing = 0x02, // PC→マイコン: 受理・処理開始（「考え中」LED開始要求）
    kPlayAudio = 0x03,        // PC→マイコン: 音声再生要求
    kError = 0x04,            // PC→マイコン: エラー通知
    kCancel = 0x05,           // マイコン→PC: キャンセル通知
    kReady = 0x06,            // マイコン→PC: READY（起動完了通知）
};

// デコード済みの1パケット。
// bodyは既定アロケータ確保のまま扱う。ESP32側ではSPIRAM malloc有効の既定sdkconfig
// （16KB超はPSRAM配置）に任せるため、heap_caps_mallocの明示指定はしない。
struct Packet {
    uint8_t cmd = 0;
    std::vector<uint8_t> body;
};

// CMDとBODYからパケットのバイト列を組み立てて out へ格納する。
// bodySize が kMaxBodySize を超える場合は false を返し、out は変更しない。
// （PC側では cmd の範囲逸脱も ValueError だが、C++では uint8_t 型で表現し切れるため
// ランタイム検査は行わない）
bool encodePacket(uint8_t cmd, const uint8_t* body, size_t bodySize, std::vector<uint8_t>& out);

// BODYなし（SIZE=0）パケット用のオーバーロード。
bool encodePacket(uint8_t cmd, std::vector<uint8_t>& out);

// ストリーミングでバイト列を受け取り、パケットへデコードするパーサ。
//
// シリアル受信のように断片的に届くバイト列を feed() で逐次投入する想定。
// ヘッダ受信後にBODYが届かないまま時間切れになるケースを検知するため、
// データが届かない間も pollTimeout() を定期的に呼び出す必要がある。
class PacketParser {
public:
    // ミリ秒単価の単調増加時刻を返す関数（実機では millis を渡す）。
    // テスト時は差し替え可能。
    using TimeFunc = std::function<uint32_t()>;

    explicit PacketParser(TimeFunc timeFunc);

    // 受信バイト列を投入し、完成したパケットのリストを返す（0件以上）。
    // sizeが0ならdataはnullptrでもよい。sizeが1以上ならdataは有効な領域を指すこと。
    std::vector<Packet> feed(const uint8_t* data, size_t size);

    // BODY受信タイムアウトを判定し、必要ならバッファとヘッダ状態をリセットする。
    // タイムアウトによりリセットが発生した場合 true を返す。
    bool pollTimeout();

    // ヘッダ受信済みでBODYを受信途中か（＝大きなBODYを取り込み中か）。上位層は受信中に
    // NeoPixel更新等の重い処理を止め、USB CDC受信の取りこぼしを防ぐために使う。
    bool isReceivingBody() const { return awaitingBody_; }

private:
    std::vector<Packet> drain();
    bool resync();
    void resetHeader();

    std::vector<uint8_t> buffer_;
    TimeFunc timeFunc_;
    bool awaitingBody_ = false;
    uint8_t headerCmd_ = 0;
    uint32_t headerSize_ = 0;
    uint32_t bodyStartMs_ = 0;
};

}  // namespace transport
