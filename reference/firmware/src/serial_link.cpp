// シリアル通信層・接続ハンドシェイクの実装。
#include "serial_link.h"

#include <utility>

#ifdef ARDUINO
#include <algorithm>
#include <atomic>
#include <cstring>

#include <Arduino.h>
#include <USB.h>
#include <esp32-hal-tinyusb.h>
#include <esp_heap_caps.h>
#endif

namespace serial_link {

HandshakeTimer::HandshakeTimer(TimeFunc timeFunc) : timeFunc_(std::move(timeFunc)) {}

void HandshakeTimer::onRecordedAudioSent() {
    state_ = State::kWaitingAccept;
    waitStartMs_ = timeFunc_();
}

TimeoutEvent HandshakeTimer::onAcceptReceived() {
    // メインループがpoll()より先に受信イベントを配送しても、期限超過を
    // 正常受信として扱わないようイベント受理時にも判定する。
    const TimeoutEvent timeout = poll();
    if (timeout != TimeoutEvent::kNone) {
        return timeout;
    }
    if (state_ != State::kWaitingAccept) {
        return TimeoutEvent::kNone;
    }
    state_ = State::kWaitingResponse;
    waitStartMs_ = timeFunc_();
    return TimeoutEvent::kNone;
}

TimeoutEvent HandshakeTimer::onResponseReceived() {
    const TimeoutEvent timeout = poll();
    if (timeout != TimeoutEvent::kNone) {
        return timeout;
    }
    if (state_ != State::kWaitingResponse) {
        return TimeoutEvent::kNone;
    }
    state_ = State::kIdle;
    return TimeoutEvent::kNone;
}

void HandshakeTimer::reset() {
    state_ = State::kIdle;
}

TimeoutEvent HandshakeTimer::poll() {
    // 経過時間は符号なし減算で求める。millis()の32bitラップアラウンド
    // （約49日周期）をまたいでも正しく判定できる（packet.cppと同じ手法）。
    switch (state_) {
        case State::kWaitingAccept:
            if (timeFunc_() - waitStartMs_ >= kAcceptTimeoutMs) {
                state_ = State::kIdle;
                return TimeoutEvent::kAcceptTimeout;
            }
            return TimeoutEvent::kNone;
        case State::kWaitingResponse:
            if (timeFunc_() - waitStartMs_ >= kResponseTimeoutMs) {
                state_ = State::kIdle;
                return TimeoutEvent::kResponseTimeout;
            }
            return TimeoutEvent::kNone;
        case State::kIdle:
        default:
            return TimeoutEvent::kNone;
    }
}

#ifdef ARDUINO

// ==== 独自CDCドライバ（コアのUSBCDCクラス迂回） ====
//
// なぜ迂回するか: arduino-esp32 2.0.17 の USBCDC::_onRX() は受信データを1バイトごとに
// FreeRTOSキューへ投入するため、host→device スループットが約44KB/sで頭打ちになり、
// 音声データレート（24kHz×16bit=48KB/s）を下回る（docs/issue_usb_throughput.md）。
// ここではCDCインターフェースを自前登録し、TinyUSBのFIFO（64B）からUSBデバイスタスク
// 文脈で一括読みしてSPSCリングバッファへ蓄積する。per-byte処理を排除することで
// エンドポイントの再アームをパケット到着直後に行い、リンク本来の速度を引き出す。
//
// 前提: ARDUINO_USB_CDC_ON_BOOT=0（platformio.ini）。コアの USBCDC.o は
// tud_cdc_rx_cb 等を強シンボルで定義しているため、Serial（USBSerial）を一切参照しない
// ことでリンク対象から外し、本ファイルの定義と衝突させない。

namespace {

// 受信リング容量。USBフルスピードの実効上限（≒1.2MB/s）でメインループが約0.8秒
// 停止しても溢れない大きさとし、PSRAMへ確保する（内蔵RAMを圧迫しない）。
constexpr size_t kRxRingBytes = 1024 * 1024;
// PSRAM確保に失敗した場合の内蔵RAMフォールバック容量。
constexpr size_t kRxRingFallbackBytes = 16 * 1024;
// TX進捗が止まった場合の打ち切り時間。ホストが受信を止めてもsendPacketを無限に
// ブロックさせない（PC側 write_timeout と同趣旨のデバイス側安全弁）。
// 3.5秒の根拠: task8で観測したIN転送の一過性詰まり（実測1〜6秒程度で自然回復）を
// 失敗にせず待って自己回復させるため、PC側パーサの無進捗タイムアウト5秒より
// 短い範囲で最大にしている。
constexpr uint32_t kTxStallTimeoutMs = 3500;

// ポートオープン検知（DTR確立）からREADY再送までの待ち時間。ホスト側のオープン処理は
// 「DTRアサート→受信バッファのパージ」の順で進むことがあり（pyserial/Windows）、
// 検知直後に送るとREADYがパージで捨てられるため、オープン完了を待ってから送る。
constexpr uint32_t kReadyResendDelayMs = 200;

uint8_t* g_rxRing = nullptr;
size_t g_rxRingSize = 0;
// SPSCリングの読み書き位置。書き手=USBデバイスタスク（tud_cdc_rx_cb）、
// 読み手=メインループ（pumpIncoming）。デュアルコア間の可視性のためatomicで受け渡す。
std::atomic<size_t> g_rxHead{0};
std::atomic<size_t> g_rxTail{0};
// リング満杯での読み捨てバイト数（物理的に起きない想定の安全弁。デバッグ用に計数）。
std::atomic<uint32_t> g_rxDroppedBytes{0};

// CDCのデータIN（device→host）エンドポイントアドレス。下のディスクリプタと一致させること。
constexpr uint8_t kCdcEpIn = 0x84;

// CDCディスクリプタ。コアUSBCDC.cppのload_cdc_descriptorと同一内容
// （エンドポイント・文字列も同じにし、ホストからは従来と同じCDCデバイスに見せる）。
uint16_t loadCdcDescriptor(uint8_t* dst, uint8_t* itf) {
    const uint8_t strIndex = tinyusb_add_string_descriptor("TinyUSB CDC");
    const uint8_t descriptor[TUD_CDC_DESC_LEN] = {
        // Interface number, string index, EP notification address and size,
        // EP data address (out, in) and size.
        TUD_CDC_DESCRIPTOR(*itf, strIndex, 0x85, 64, 0x03, kCdcEpIn, 64)};
    *itf += 2;
    std::memcpy(dst, descriptor, TUD_CDC_DESC_LEN);
    return TUD_CDC_DESC_LEN;
}

// 大量送信中にアイドルタスク（ウォッチドッグの餌やり）を飢えさせないよう、この量を
// 送るごとに1msだけ明け渡す。64B/msに律速されない範囲で十分小さいペナルティにする。
constexpr size_t kTxBytesPerBreath = 16 * 1024;

// TX FIFOの空き容量の最大値（＝FIFO容量）。初回のwriteAll冒頭（FIFOが空の時点）で計測し、
// 送信完了判定（FIFOが完全に排出されたか）に使う。
uint32_t g_txFifoCapacity = 0;

// 全バイトをCDCのTX FIFOへ書き切り、FIFOが完全に排出されるまで待つ。
// 進捗がkTxStallTimeoutMs止まったら失敗を返す。
//
// FIFO（64B）の排出はUSBデバイスタスク（高優先度）が行う。満杯時にdelay(1)で待つと
// 64B/msに律速され、最大約1.44MBの録音送信が20秒超かかるため、taskYIELD()で即座に
// 再試行してUSBの1msフレームに複数パケットを載せる（数百KB/sまで向上する）。
//
// 末尾の排出待ちを行う理由: FIFO受理時点でtrueを返すと、ホスト側の受信が停止した場合に
// パケット末尾がFIFOに残ったまま「送信成功」となり、受け手には末尾欠けのパケットが
// 無言で届く（task8のE2Eで、失敗ターンがPC側ログに一切痕跡を残さない事象の想定原因）。
// 排出まで確認することで、この形の消失を「送信失敗→エラー点滅＋診断」に転換する。
// 送信失敗時にFIFOの送り残しを破棄する。残すと次のパケットの前に古い末尾断片が流れ、
// 受信側パーサを混乱させる（再同期で回復はするが、無用なごみを流さない）。
bool failTx() {
    tud_cdc_n_write_clear(0);
    return false;
}

// 全バイトをTX FIFOへ流し込み、FIFOが完全に排出されるまで待ってから成功と判定する。
//
// 送信方式の変遷（task8の間欠停止調査。docs/task8_verification.md G）:
//   v0: 毎チャンクflush → 末尾がFIFOに残留したまま成功扱いになる停止が発生
//   v1: flushをFIFO満杯時と完了後に限定＋排出待ちで再flush → 停止は検知できるが防げず
//   v2: INエンドポイント転送完了(usbd_edpt_busy)で完全直列化 → 悪化
//       （busy解除の直後はUSBタスクのauto-flushがFIFOを読む瞬間で、そこへ書き込む形になる）
//   v3（現行）: v1のストリーミングへ戻し、停止打ち切りを1秒→3.5秒へ延長。
//       実測の詰まりは1〜6秒程度で自然回復するため、再flushを続けながら待つことで
//       多くの詰まりを「失敗」ではなく「数秒の遅延」へ変換する（PC側の無進捗5秒未満）。
bool writeAll(const uint8_t* data, size_t size) {
    if (g_txFifoCapacity == 0) {
        // 初回呼び出し（起動時READY送信）の時点ではFIFOは空なので、空き容量＝FIFO容量。
        g_txFifoCapacity = tud_cdc_n_write_available(0);
    }
    size_t sent = 0;
    size_t sentSinceBreath = 0;
    uint32_t lastProgressMs = millis();
    while (sent < size) {
        if (!tud_cdc_n_connected(0)) {
            return failTx();  // DTR未確立（ホスト不在）。FIFOに溜め込まず即失敗にする
        }
        const uint32_t n = tud_cdc_n_write(0, data + sent, size - sent);
        if (n > 0) {
            sent += n;
            sentSinceBreath += n;
            lastProgressMs = millis();
            if (sentSinceBreath >= kTxBytesPerBreath) {
                sentSinceBreath = 0;
                delay(1);  // アイドルタスクへ実行権を渡す（WDT対策）
            }
        } else {
            // FIFO満杯。排出を要求して待つ（詰まり時の再キックを兼ねる）。
            tud_cdc_n_write_flush(0);
            if (millis() - lastProgressMs >= kTxStallTimeoutMs) {
                return failTx();
            }
            taskYIELD();  // USBデバイスタスクは高優先度のため、譲らなくても排出は進む
        }
    }
    tud_cdc_n_write_flush(0);
    // FIFOに残った末尾がUSBエンドポイントへ排出されるまで待つ（空き容量の増加を進捗とみなす）。
    // 待機中もflushを繰り返し、送出予約の取り逃しからの自己回復を促す。
    uint32_t prevAvailable = tud_cdc_n_write_available(0);
    while (g_txFifoCapacity != 0 && prevAvailable < g_txFifoCapacity) {
        if (!tud_cdc_n_connected(0)) {
            return failTx();
        }
        tud_cdc_n_write_flush(0);
        const uint32_t available = tud_cdc_n_write_available(0);
        if (available > prevAvailable) {
            prevAvailable = available;
            lastProgressMs = millis();
        } else if (millis() - lastProgressMs >= kTxStallTimeoutMs) {
            return failTx();
        }
        taskYIELD();
    }
    return true;
}

}  // namespace

// TinyUSBの弱シンボルコールバック差し替え。USBデバイスタスク文脈で呼ばれる。
// FIFOの読み手はこのコールバックのみ（単一消費者）とし、tu_fifoのSPSC前提を守る。
extern "C" void tud_cdc_rx_cb(uint8_t itf) {
    if (itf != 0 || g_rxRing == nullptr) {
        return;
    }
    for (;;) {
        const uint32_t avail = tud_cdc_n_available(0);
        if (avail == 0) {
            return;
        }
        const size_t head = g_rxHead.load(std::memory_order_acquire);
        const size_t tail = g_rxTail.load(std::memory_order_relaxed);
        const size_t freeSpace = (head + g_rxRingSize - tail - 1) % g_rxRingSize;
        if (freeSpace == 0) {
            // 想定外（メインループの長時間停止時のみ）。FIFOを読み捨ててエンドポイントを
            // 止めない。欠落はパーサのSYNC再同期・BODYタイムアウトで回復する。
            uint8_t scrap[64];
            const uint32_t dropped = tud_cdc_n_read(0, scrap, sizeof(scrap));
            if (dropped == 0) {
                return;
            }
            g_rxDroppedBytes.fetch_add(dropped, std::memory_order_relaxed);
            continue;
        }
        const size_t contig = std::min(freeSpace, g_rxRingSize - tail);
        const uint32_t n =
            tud_cdc_n_read(0, g_rxRing + tail, static_cast<uint32_t>(std::min<size_t>(contig, avail)));
        if (n == 0) {
            return;
        }
        g_rxTail.store((tail + n) % g_rxRingSize, std::memory_order_release);
    }
}

bool begin() {
    if (g_rxRing == nullptr) {
        g_rxRing = static_cast<uint8_t*>(heap_caps_malloc(kRxRingBytes, MALLOC_CAP_SPIRAM));
        g_rxRingSize = kRxRingBytes;
        if (g_rxRing == nullptr) {
            // PSRAM不調時の縮退。バースト耐性は落ちるが受信自体は継続できる。
            g_rxRing = static_cast<uint8_t*>(
                heap_caps_malloc(kRxRingFallbackBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            g_rxRingSize = (g_rxRing != nullptr) ? kRxRingFallbackBytes : 0;
        }
    }
    if (g_rxRing == nullptr) {
        return false;
    }
    // CDCインターフェースを自前登録してからUSBデバイスを開始する
    // （ディスクリプタはUSB.begin()時に組み立てられるため、順序が重要）。
    if (tinyusb_enable_interface(USB_INTERFACE_CDC, TUD_CDC_DESC_LEN, loadCdcDescriptor) != ESP_OK) {
        return false;
    }
    return USB.begin();
}

bool sendReady() {
    return sendPacket(static_cast<uint8_t>(transport::Command::kReady), nullptr, 0);
}

bool sendPacket(uint8_t cmd, const uint8_t* body, size_t bodySize) {
    std::vector<uint8_t> out;
    if (!transport::encodePacket(cmd, body, bodySize, out)) {
        return false;
    }
    return writeAll(out.data(), out.size());
}

void pumpIncoming(transport::PacketParser& parser, std::vector<transport::Packet>& outPackets) {
    // ホストのポートオープン（DTR確立）を接続状態の立ち上がりエッジで検知し、READYを
    // 送り直す（§3.4）。起動時のREADYはホスト不在で失われるため、開かれた時点で改めて
    // 起動完了を通知する。tud_cdc_line_state_cbの発火には依存せず、TinyUSBが内部管理する
    // ライン状態（tud_cdc_n_connected）を毎ループ確認する。送信はエッジ直後ではなく
    // kReadyResendDelayMs待ってから行う（ホストのオープン処理中のパージでREADYが
    // 捨てられるのを避ける）。待機中に切断されたら取り消す。
    static bool s_wasConnected = false;
    static bool s_readyPending = false;
    static uint32_t s_connectedAtMs = 0;
    const bool connected = tud_cdc_n_connected(0);
    if (connected && !s_wasConnected) {
        s_readyPending = true;
        s_connectedAtMs = millis();
    } else if (!connected) {
        s_readyPending = false;
    }
    s_wasConnected = connected;
    if (s_readyPending && millis() - s_connectedAtMs >= kReadyResendDelayMs) {
        s_readyPending = false;
        sendReady();
    }
    bool consumed = false;
    for (;;) {
        const size_t tail = g_rxTail.load(std::memory_order_acquire);
        const size_t head = g_rxHead.load(std::memory_order_relaxed);
        if (head == tail) {
            break;
        }
        // リングの連続領域をそのままパーサへ渡す（コピーはパーサ内部の蓄積のみ）。
        const size_t contig = (tail > head) ? (tail - head) : (g_rxRingSize - head);
        auto decoded = parser.feed(g_rxRing + head, contig);
        outPackets.insert(outPackets.end(), std::make_move_iterator(decoded.begin()),
                          std::make_move_iterator(decoded.end()));
        g_rxHead.store((head + contig) % g_rxRingSize, std::memory_order_release);
        consumed = true;
    }
    if (!consumed) {
        // 新しいデータが来ない間も、途中で途切れたBODYをタイムアウトで破棄する。
        parser.pollTimeout();
    }
}

uint32_t rxDroppedBytes() { return g_rxDroppedBytes.load(std::memory_order_relaxed); }

void rebootToBootloader() {
    // USBの切断をホストへ伝えてからROMブートローダーへ再起動する（esptool書き込み用）。
    usb_persist_restart(RESTART_BOOTLOADER);
}

#endif  // ARDUINO

}  // namespace serial_link
