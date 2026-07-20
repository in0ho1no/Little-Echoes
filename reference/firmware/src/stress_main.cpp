// task8 USB TXストレステスト用ファームウェア（調査専用。アプリ本体は main.cpp）。
//
// マイコン→PCの大きな0x01送信が末尾で停止する間欠問題（docs/task8_verification.md G）を
// ボタン操作なしで反復再現するため、PCからの要求に応答してパケットを送る。
// スピーカー・マイク・LEDは使わない（無音・消灯。就寝中の無人試験を想定）。
//
// プロトコル（scripts/task8_txstress.py が相手）:
//   PC→FW 0x02 BODY=4B LEサイズ : 指定サイズの決定論パターンBODYを 0x01 で送り返す
//   PC→FW 0x03 BODY=Nバイト     : echoバッファへ保存し、0x7E BODY=4B LE保存サイズ で応答
//   PC→FW 0x04 BODY=0           : echoバッファの内容を 0x01 で送り返す
//   PC→FW 0x10 BODY=[0|1]       : NeoPixel演出の有効化（アプリ環境の再現。送信直前のshow含む）
//   PC→FW 0x11 BODY=[0|1]       : マイク録音モードの有効化（各パターン送信前に約1.6秒の実録音）
//   FW→PC 0x7F BODY=[reason:1][detail:4 LE] : 送信失敗等の診断（main.cppと同形式）
//
// パターン: body[0..3]=シーケンス番号LE、body[i]=uint8_t((i*151) ^ (i>>8)) (i>=4)。
// PC側が同じ式で再計算して照合し、化け・欠けを検出する。
#include <Arduino.h>
#include <M5Unified.h>

#include <cstring>
#include <vector>

#include <esp_heap_caps.h>

#include "audio_record.h"
#include "led_controller.h"
#include "packet.h"
#include "serial_link.h"

namespace {

uint32_t nowMs() { return static_cast<uint32_t>(millis()); }

constexpr size_t kMaxPayloadBytes = 1'440'000;  // 本番の最大録音サイズと同じ

constexpr uint8_t kCmdSendPattern = 0x02;
constexpr uint8_t kCmdStoreEcho = 0x03;
constexpr uint8_t kCmdSendEcho = 0x04;
constexpr uint8_t kCmdSetLed = 0x10;
constexpr uint8_t kCmdSetMic = 0x11;
constexpr uint8_t kCmdReboot = 0x7D;  // ダウンロードモード再起動（遠隔書き込み用。BODY空必須）
constexpr uint8_t kCmdEchoStored = 0x7E;
constexpr uint8_t kCmdDiag = 0x7F;

constexpr uint8_t kDiagSendPatternFailed = 0x01;
constexpr uint8_t kDiagSendEchoFailed = 0x02;
constexpr uint8_t kDiagStoreAckFailed = 0x03;
constexpr uint8_t kDiagLedMode = 0x10;  // detail=有効化状態（設定ackを兼ねる）
constexpr uint8_t kDiagMicMode = 0x11;

// マイク録音モードでの1回あたりの実録音時間。長押し確定（1.5秒）直後の解放を模す。
constexpr uint32_t kMicRecordMs = 1600;

uint8_t* g_pattern = nullptr;
uint8_t* g_echo = nullptr;
size_t g_echoSize = 0;
uint32_t g_seq = 0;

transport::PacketParser g_parser(nowMs);
std::vector<transport::Packet> g_packets;

led_controller::LedController g_led(nowMs);
audio_record::MicRecorder g_mic;
bool g_ledEnabled = false;
bool g_micEnabled = false;
bool g_m5Started = false;

// アプリ（main.cpp）と同じ初期化順でM5Unifiedを遅延起動する（マイクモードで必要）。
void ensureM5Started() {
    if (g_m5Started) {
        return;
    }
    auto cfg = M5.config();
    cfg.serial_baudrate = 0;  // UART0を起動しない（main.cppと同じ）
    M5.begin(cfg);
    g_mic.begin();
    g_m5Started = true;
}

void sendDiag(uint8_t reason, uint32_t detail) {
    uint8_t body[5];
    body[0] = reason;
    body[1] = static_cast<uint8_t>(detail & 0xFF);
    body[2] = static_cast<uint8_t>((detail >> 8) & 0xFF);
    body[3] = static_cast<uint8_t>((detail >> 16) & 0xFF);
    body[4] = static_cast<uint8_t>((detail >> 24) & 0xFF);
    serial_link::sendPacket(kCmdDiag, body, sizeof(body));
}

// パターンBODYを組み立てる（先頭4バイト=seq、以降は位置依存の決定論値）。
void fillPattern(uint8_t* dst, size_t size, uint32_t seq) {
    for (size_t i = 4; i < size; ++i) {
        dst[i] = static_cast<uint8_t>((i * 151) ^ (i >> 8));
    }
    if (size >= 4) {
        dst[0] = static_cast<uint8_t>(seq & 0xFF);
        dst[1] = static_cast<uint8_t>((seq >> 8) & 0xFF);
        dst[2] = static_cast<uint8_t>((seq >> 16) & 0xFF);
        dst[3] = static_cast<uint8_t>((seq >> 24) & 0xFF);
    }
}

uint32_t readLe32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

void handlePacket(const transport::Packet& pkt) {
    switch (pkt.cmd) {
        case kCmdSendPattern: {
            if (pkt.body.size() != 4 || g_pattern == nullptr) {
                return;
            }
            size_t want = readLe32(pkt.body.data());
            if (want > kMaxPayloadBytes) {
                want = kMaxPayloadBytes;
            }
            if (g_micEnabled) {
                // アプリの録音→停止→送信の並びを再現する（I2S DMA・M5内部タスクの副作用込み）。
                // 録音データ自体は使わず、PCへはパターンを送って内容照合を維持する。
                if (g_mic.startRecording()) {
                    const uint32_t startedMs = millis();
                    while (millis() - startedMs < kMicRecordMs && g_mic.loop()) {
                        delay(1);
                    }
                    g_mic.stopRecording();
                }
            }
            if (g_ledEnabled) {
                // アプリのapply()と同じく、送信直前に状態設定→即時render（NeoPixel show）を行う。
                g_led.setStatus(led_controller::LedStatus::kIdle);
                g_led.loop();
            }
            fillPattern(g_pattern, want, g_seq);
            if (!serial_link::sendPacket(0x01, g_pattern, want)) {
                sendDiag(kDiagSendPatternFailed, static_cast<uint32_t>(want));
            }
            ++g_seq;
            break;
        }
        case kCmdSetLed:
            if (pkt.body.size() == 1) {
                g_ledEnabled = pkt.body[0] != 0;
                if (g_ledEnabled) {
                    g_led.begin();
                    g_led.setStatus(led_controller::LedStatus::kIdle);
                }
                sendDiag(kDiagLedMode, g_ledEnabled ? 1 : 0);
            }
            break;
        case kCmdSetMic:
            if (pkt.body.size() == 1) {
                g_micEnabled = pkt.body[0] != 0;
                if (g_micEnabled) {
                    ensureM5Started();
                }
                sendDiag(kDiagMicMode, g_micEnabled ? 1 : 0);
            }
            break;
        case kCmdStoreEcho: {
            if (g_echo == nullptr) {
                return;
            }
            g_echoSize = pkt.body.size() <= kMaxPayloadBytes ? pkt.body.size() : kMaxPayloadBytes;
            if (g_echoSize > 0) {
                std::memcpy(g_echo, pkt.body.data(), g_echoSize);
            }
            const uint32_t stored = static_cast<uint32_t>(g_echoSize);
            uint8_t ack[4] = {static_cast<uint8_t>(stored & 0xFF), static_cast<uint8_t>((stored >> 8) & 0xFF),
                              static_cast<uint8_t>((stored >> 16) & 0xFF),
                              static_cast<uint8_t>((stored >> 24) & 0xFF)};
            if (!serial_link::sendPacket(kCmdEchoStored, ack, sizeof(ack))) {
                sendDiag(kDiagStoreAckFailed, stored);
            }
            break;
        }
        case kCmdSendEcho: {
            if (g_echo == nullptr) {
                return;
            }
            if (!serial_link::sendPacket(0x01, g_echo, g_echoSize)) {
                sendDiag(kDiagSendEchoFailed, static_cast<uint32_t>(g_echoSize));
            }
            break;
        }
        case kCmdReboot:
            if (pkt.body.empty()) {
                serial_link::rebootToBootloader();  // 戻らない
            }
            break;
        default:
            break;
    }
}

}  // namespace

void setup() {
    g_pattern = static_cast<uint8_t*>(heap_caps_malloc(kMaxPayloadBytes, MALLOC_CAP_SPIRAM));
    g_echo = static_cast<uint8_t*>(heap_caps_malloc(kMaxPayloadBytes, MALLOC_CAP_SPIRAM));
    if (!serial_link::begin()) {
        return;  // 通信不能。READYを送らず沈黙する（PC側のREADY待ちタイムアウトで露見する）
    }
    serial_link::sendReady();
}

void loop() {
    g_packets.clear();
    serial_link::pumpIncoming(g_parser, g_packets);
    for (const auto& pkt : g_packets) {
        handlePacket(pkt);
    }
    if (g_ledEnabled) {
        g_led.loop();  // アプリと同じく毎ループのLED更新（NeoPixel show最大50fps）
    }
    delay(1);  // 本番main.cppと同じく下位タスクへCPUを回す
}
