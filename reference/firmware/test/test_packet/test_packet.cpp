// transport::packet のホスト側ユニットテスト（PC側 src/tests/test_packet.py と同観点）。
// 加えて、組込み特有の観点として millis() 32bitラップアラウンド境界を検証する。
#include <unity.h>

#include <cstdint>
#include <vector>

#include "packet.h"

using transport::Command;
using transport::encodePacket;
using transport::kBodyTimeoutMs;
using transport::kHeaderSize;
using transport::kMaxBodySize;
using transport::kSync;
using transport::Packet;
using transport::PacketParser;

namespace {

// テスト用の手動進行クロック（ミリ秒）
uint32_t g_fakeNowMs = 0;

uint32_t fakeClock() {
    return g_fakeNowMs;
}

// 呼び出しごとに指定した値を順に返すテスト用クロック。
// 最後の値に達した後は同じ値を返し続ける。timeFuncの呼び出し回数と
// タイミングを厳密に制御し、内部実装の呼び出し回数に依存した回帰を
// 検出するために使う。
std::vector<uint32_t> g_sequencedValues;
size_t g_sequencedIndex = 0;

uint32_t sequencedClock() {
    const size_t idx = (g_sequencedIndex < g_sequencedValues.size())
                           ? g_sequencedIndex
                           : g_sequencedValues.size() - 1;
    ++g_sequencedIndex;
    return g_sequencedValues[idx];
}

std::vector<uint8_t> mustEncode(Command cmd, const std::vector<uint8_t>& body = {}) {
    std::vector<uint8_t> out;
    TEST_ASSERT_TRUE(encodePacket(static_cast<uint8_t>(cmd), body.data(), body.size(), out));
    return out;
}

// SIZEフィールドを任意値にしたヘッダのみのバイト列を作る（不正SIZEやBODY未達の再現用）
std::vector<uint8_t> makeRawHeader(Command cmd, uint32_t size) {
    return {
        kSync[0],
        kSync[1],
        static_cast<uint8_t>(cmd),
        static_cast<uint8_t>(size >> 24),
        static_cast<uint8_t>(size >> 16),
        static_cast<uint8_t>(size >> 8),
        static_cast<uint8_t>(size),
    };
}

}  // namespace

void setUp() {
    g_fakeNowMs = 0;
    g_sequencedValues.clear();
    g_sequencedIndex = 0;
}

void tearDown() {}

// ---- encodePacket ----

// SYNC/CMD/SIZE(ビッグエンディアン)/BODYのレイアウトが仕様どおりであること
static void test_encode_header_layout() {
    const std::vector<uint8_t> body = {0xAA, 0xBB};
    const auto data = mustEncode(Command::kReady, body);
    TEST_ASSERT_EQUAL_size_t(kHeaderSize + 2, data.size());
    TEST_ASSERT_EQUAL_UINT8(kSync[0], data[0]);
    TEST_ASSERT_EQUAL_UINT8(kSync[1], data[1]);
    TEST_ASSERT_EQUAL_UINT8(0x06, data[2]);
    TEST_ASSERT_EQUAL_UINT8(0x00, data[3]);
    TEST_ASSERT_EQUAL_UINT8(0x00, data[4]);
    TEST_ASSERT_EQUAL_UINT8(0x00, data[5]);
    TEST_ASSERT_EQUAL_UINT8(0x02, data[6]);
    TEST_ASSERT_EQUAL_UINT8(0xAA, data[7]);
    TEST_ASSERT_EQUAL_UINT8(0xBB, data[8]);
}

// CMDの境界値0x00/0xFFがそのままCMDバイトに載ること
// （範囲逸脱の拒否はPC側ではValueErrorだが、C++はuint8_t型で表現し切れるため対象外）
static void test_encode_cmd_boundary_values() {
    std::vector<uint8_t> out;
    TEST_ASSERT_TRUE(encodePacket(0x00, out));
    TEST_ASSERT_EQUAL_UINT8(0x00, out[2]);
    TEST_ASSERT_TRUE(encodePacket(0xFF, out));
    TEST_ASSERT_EQUAL_UINT8(0xFF, out[2]);
}

// BODY省略時はSIZE=0のヘッダのみ7バイトになること
static void test_encode_empty_body() {
    std::vector<uint8_t> out;
    TEST_ASSERT_TRUE(encodePacket(static_cast<uint8_t>(Command::kAcceptProcessing), out));
    TEST_ASSERT_EQUAL_size_t(kHeaderSize, out.size());
    TEST_ASSERT_EQUAL_UINT8(0x00, out[6]);
}

// SIZE上限ちょうど(2MB)は受理し、1バイト超過は拒否してoutを変更しないこと
static void test_encode_body_size_boundary() {
    std::vector<uint8_t> body(kMaxBodySize + 1, 0x00);
    std::vector<uint8_t> out = {0xDE, 0xAD};
    TEST_ASSERT_FALSE(
        encodePacket(static_cast<uint8_t>(Command::kRecordedAudio), body.data(), body.size(), out));
    TEST_ASSERT_EQUAL_size_t(2, out.size());
    TEST_ASSERT_EQUAL_UINT8(0xDE, out[0]);

    TEST_ASSERT_TRUE(
        encodePacket(static_cast<uint8_t>(Command::kRecordedAudio), body.data(), kMaxBodySize, out));
    TEST_ASSERT_EQUAL_size_t(kHeaderSize + kMaxBodySize, out.size());
}

// ---- PacketParser: 基本デコード ----

// エンコードしたBODY付きパケットがそのままデコードできること（ラウンドトリップ）
static void test_roundtrip_with_body() {
    const std::vector<uint8_t> body = {0x00, 0x01, 0x02, 0x03};
    const auto data = mustEncode(Command::kRecordedAudio, body);
    PacketParser parser(fakeClock);
    const auto packets = parser.feed(data.data(), data.size());
    TEST_ASSERT_EQUAL_size_t(1, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x01, packets[0].cmd);
    TEST_ASSERT_EQUAL_size_t(4, packets[0].body.size());
    TEST_ASSERT_EQUAL_UINT8_ARRAY(body.data(), packets[0].body.data(), body.size());
}

// SIZE=0のパケットが空BODYでデコードできること
static void test_roundtrip_with_empty_body() {
    const auto data = mustEncode(Command::kAcceptProcessing);
    PacketParser parser(fakeClock);
    const auto packets = parser.feed(data.data(), data.size());
    TEST_ASSERT_EQUAL_size_t(1, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x02, packets[0].cmd);
    TEST_ASSERT_EQUAL_size_t(0, packets[0].body.size());
}

// 1回のfeedに複数パケットが含まれる場合、すべて順番どおり返ること
static void test_multiple_packets_in_single_feed() {
    auto data = mustEncode(Command::kReady);
    const auto second = mustEncode(Command::kCancel);
    data.insert(data.end(), second.begin(), second.end());
    PacketParser parser(fakeClock);
    const auto packets = parser.feed(data.data(), data.size());
    TEST_ASSERT_EQUAL_size_t(2, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x06, packets[0].cmd);
    TEST_ASSERT_EQUAL_UINT8(0x05, packets[1].cmd);
}

// 空入力はnullptrでも安全なno-opとして扱えること
static void test_empty_feed_accepts_null_pointer() {
    PacketParser parser(fakeClock);
    const auto packets = parser.feed(nullptr, 0);
    TEST_ASSERT_EQUAL_size_t(0, packets.size());
}

// 1バイトずつ分割して届いてもパケットが完成すること
static void test_packet_split_across_multiple_feeds() {
    const std::vector<uint8_t> body = {'P', 'C', 'M', '_', 'B', 'O', 'D', 'Y'};
    const auto data = mustEncode(Command::kPlayAudio, body);
    PacketParser parser(fakeClock);
    std::vector<Packet> packets;
    for (size_t i = 0; i < data.size(); ++i) {
        auto got = parser.feed(&data[i], 1);
        packets.insert(packets.end(), got.begin(), got.end());
    }
    TEST_ASSERT_EQUAL_size_t(1, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x03, packets[0].cmd);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(body.data(), packets[0].body.data(), body.size());
}

// ---- PacketParser: 再同期 ----

// 先頭のゴミバイト（偽のSYNC先頭バイト含む）を読み捨てて再同期できること
static void test_resync_skips_garbage_prefix() {
    std::vector<uint8_t> data = {0x00, 0xFF, 0xA5, 0x00, 'g', 'a', 'r', 'b'};
    const auto packet = mustEncode(Command::kReady);
    data.insert(data.end(), packet.begin(), packet.end());
    PacketParser parser(fakeClock);
    const auto packets = parser.feed(data.data(), data.size());
    TEST_ASSERT_EQUAL_size_t(1, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x06, packets[0].cmd);
}

// ゴミの末尾がSYNC先頭バイト(0xA5)で終わり、続き(0x5A以降)が次のfeedで届く
// 分割SYNCでも再同期できること
static void test_resync_keeps_trailing_sync_first_byte() {
    const std::vector<uint8_t> garbageEndingWithSyncHead = {0x00, 0xFF, 0xA5};
    const auto packet = mustEncode(Command::kReady);
    PacketParser parser(fakeClock);
    auto packets =
        parser.feed(garbageEndingWithSyncHead.data(), garbageEndingWithSyncHead.size());
    TEST_ASSERT_EQUAL_size_t(0, packets.size());
    // 0xA5は既にバッファ内に残っているので、2バイト目以降を投入する
    packets = parser.feed(packet.data() + 1, packet.size() - 1);
    TEST_ASSERT_EQUAL_size_t(1, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x06, packets[0].cmd);
}

// SIZEが上限2MBを超えるヘッダは読み捨てられ、後続の正常パケットへ再同期できること
static void test_oversized_size_field_triggers_resync() {
    auto data = makeRawHeader(Command::kRecordedAudio, kMaxBodySize + 1);
    const auto packet = mustEncode(Command::kReady);
    data.insert(data.end(), packet.begin(), packet.end());
    PacketParser parser(fakeClock);
    const auto packets = parser.feed(data.data(), data.size());
    TEST_ASSERT_EQUAL_size_t(1, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x06, packets[0].cmd);
}

// ---- PacketParser: BODY受信タイムアウト ----

// ヘッダ受信後タイムアウトを超えるとpollTimeoutがリセットを報告し、
// その後の正常パケットを受信できること
static void test_body_timeout_resets_parser_and_recovers() {
    PacketParser parser(fakeClock);
    const auto headerOnly = makeRawHeader(Command::kRecordedAudio, 10);
    TEST_ASSERT_EQUAL_size_t(0, parser.feed(headerOnly.data(), headerOnly.size()).size());

    g_fakeNowMs += kBodyTimeoutMs + 100;
    TEST_ASSERT_TRUE(parser.pollTimeout());

    const auto packet = mustEncode(Command::kReady);
    const auto recovered = parser.feed(packet.data(), packet.size());
    TEST_ASSERT_EQUAL_size_t(1, recovered.size());
    TEST_ASSERT_EQUAL_UINT8(0x06, recovered[0].cmd);
}

// タイムアウト時、BODY断片（内部にSYNC相当値を含む）ごと破棄され、
// 次のfeedの正常パケットだけが返ること
static void test_body_timeout_discards_partial_body_before_recovery() {
    PacketParser parser(fakeClock);
    auto incomplete = makeRawHeader(Command::kRecordedAudio, 100);
    const auto embedded = mustEncode(Command::kReady);
    incomplete.insert(incomplete.end(), embedded.begin(), embedded.end());
    TEST_ASSERT_EQUAL_size_t(0, parser.feed(incomplete.data(), incomplete.size()).size());

    g_fakeNowMs += kBodyTimeoutMs + 100;
    const auto packet = mustEncode(Command::kCancel);
    const auto recovered = parser.feed(packet.data(), packet.size());
    TEST_ASSERT_EQUAL_size_t(1, recovered.size());
    TEST_ASSERT_EQUAL_UINT8(0x05, recovered[0].cmd);
}

// 期限内（タイムアウト直前）ではリセットが発生しないこと
static void test_no_timeout_within_deadline() {
    PacketParser parser(fakeClock);
    const auto data = mustEncode(Command::kPlayAudio, {'b', 'o', 'd', 'y'});
    TEST_ASSERT_EQUAL_size_t(0, parser.feed(data.data(), kHeaderSize).size());

    g_fakeNowMs += kBodyTimeoutMs - 100;
    TEST_ASSERT_FALSE(parser.pollTimeout());
}

// 経過時間がちょうどタイムアウト値ならリセットされること（PC側の >= 判定と一致）
static void test_timeout_at_exact_deadline() {
    PacketParser parser(fakeClock);
    const auto headerOnly = makeRawHeader(Command::kRecordedAudio, 10);
    parser.feed(headerOnly.data(), headerOnly.size());

    g_fakeNowMs += kBodyTimeoutMs;
    TEST_ASSERT_TRUE(parser.pollTimeout());
}

// ヘッダ未受信の間はpollTimeoutが常にfalseであること
static void test_poll_timeout_without_pending_header_returns_false() {
    PacketParser parser(fakeClock);
    TEST_ASSERT_FALSE(parser.pollTimeout());
    g_fakeNowMs += kBodyTimeoutMs * 10;
    TEST_ASSERT_FALSE(parser.pollTimeout());
}

// feed()内のタイムアウト判定は冒頭の1回だけであること。もしdrain()内で
// 再度判定される退行が起きると、2回目のクロック値（巨大値）を受け取って
// 追加直後のBODYごと誤って破棄されてしまう。
static void test_feed_checks_timeout_only_once_per_call() {
    g_sequencedValues = {0, 4000, 1000000000};
    PacketParser parser(sequencedClock);

    const std::vector<uint8_t> body = {'b', 'o', 'd', 'y'};
    const auto data = mustEncode(Command::kPlayAudio, body);

    // 1回目のクロック呼び出し(0)でBODY待ち開始時刻が設定される
    TEST_ASSERT_EQUAL_size_t(0, parser.feed(data.data(), kHeaderSize).size());

    // 2回目のクロック呼び出し(4000)はfeed()冒頭のタイムアウト判定のみで
    // 消費されるはず。ここでBODYが完成する
    const auto packets = parser.feed(data.data() + kHeaderSize, data.size() - kHeaderSize);
    TEST_ASSERT_EQUAL_size_t(1, packets.size());
    TEST_ASSERT_EQUAL_UINT8(0x03, packets[0].cmd);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(body.data(), packets[0].body.data(), body.size());
}

// BODYタイムアウトは「新しいデータがkBodyTimeoutMs届かない」停滞の検知であること（§3.2 v1.3.2）。
// 遅いリンクで大きなBODYが合計期限超をかけて届いても、進捗があれば破棄しない
// （マイコン→PCの最大約1.44MB送信の受信途中で誤破棄された実機不具合のPC側と対の再発防止）
static void test_slow_body_with_progress_does_not_time_out() {
    PacketParser parser(fakeClock);
    const std::vector<uint8_t> body = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
    const auto data = mustEncode(Command::kRecordedAudio, body);
    TEST_ASSERT_EQUAL_size_t(0, parser.feed(data.data(), kHeaderSize).size());

    std::vector<Packet> got;
    for (size_t i = kHeaderSize; i < data.size(); ++i) {
        g_fakeNowMs += kBodyTimeoutMs - 100;  // 各バイトの間隔は期限未満、総計は旧仕様の期限超
        auto packets = parser.feed(&data[i], 1);
        for (auto& p : packets) {
            got.push_back(std::move(p));
        }
    }
    TEST_ASSERT_EQUAL_size_t(1, got.size());
    TEST_ASSERT_EQUAL_UINT8(0x01, got[0].cmd);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(body.data(), got[0].body.data(), body.size());
}

// ---- millis() 32bitラップアラウンド境界（組込み特有の観点） ----

// BODY待ち開始がUINT32_MAX付近でも、ラップ後の期限内判定が誤検知しないこと
static void test_no_timeout_across_millis_wraparound() {
    g_fakeNowMs = UINT32_MAX - 1000;
    PacketParser parser(fakeClock);
    const auto headerOnly = makeRawHeader(Command::kRecordedAudio, 10);
    parser.feed(headerOnly.data(), headerOnly.size());

    // ラップをまたいで（>1000ms）かつ期限未満（< kBodyTimeoutMs）まで進める
    g_fakeNowMs += kBodyTimeoutMs - 100;
    TEST_ASSERT_FALSE(parser.pollTimeout());
}

// ラップをまたいでタイムアウト値を超えた場合は正しくリセットされること
static void test_timeout_across_millis_wraparound() {
    g_fakeNowMs = UINT32_MAX - 1000;
    PacketParser parser(fakeClock);
    const auto headerOnly = makeRawHeader(Command::kRecordedAudio, 10);
    parser.feed(headerOnly.data(), headerOnly.size());

    // ラップをまたいで（>1000ms）かつ期限超過（>= kBodyTimeoutMs）まで進める
    g_fakeNowMs += kBodyTimeoutMs + 100;
    TEST_ASSERT_TRUE(parser.pollTimeout());
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_encode_header_layout);
    RUN_TEST(test_encode_cmd_boundary_values);
    RUN_TEST(test_encode_empty_body);
    RUN_TEST(test_encode_body_size_boundary);
    RUN_TEST(test_roundtrip_with_body);
    RUN_TEST(test_roundtrip_with_empty_body);
    RUN_TEST(test_multiple_packets_in_single_feed);
    RUN_TEST(test_empty_feed_accepts_null_pointer);
    RUN_TEST(test_packet_split_across_multiple_feeds);
    RUN_TEST(test_resync_skips_garbage_prefix);
    RUN_TEST(test_resync_keeps_trailing_sync_first_byte);
    RUN_TEST(test_oversized_size_field_triggers_resync);
    RUN_TEST(test_body_timeout_resets_parser_and_recovers);
    RUN_TEST(test_body_timeout_discards_partial_body_before_recovery);
    RUN_TEST(test_no_timeout_within_deadline);
    RUN_TEST(test_timeout_at_exact_deadline);
    RUN_TEST(test_poll_timeout_without_pending_header_returns_false);
    RUN_TEST(test_feed_checks_timeout_only_once_per_call);
    RUN_TEST(test_slow_body_with_progress_does_not_time_out);
    RUN_TEST(test_no_timeout_across_millis_wraparound);
    RUN_TEST(test_timeout_across_millis_wraparound);
    return UNITY_END();
}
