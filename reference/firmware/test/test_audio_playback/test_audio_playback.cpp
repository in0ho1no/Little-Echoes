// audio_playback のホスト側ユニットテスト（リングバッファ・エフェクトID解釈・LE PCM変換）。
// 実際のI2S再生・音質・エフェクト同期は実機確認の対象。ここではハードウェア非依存の
// リングバッファ（回り込み・満杯/空・部分読み書き・クリア）、0x03 BODY分解、
// LEバイト→サンプル変換を検証する。
#include <unity.h>

#include <cstdint>
#include <vector>

#include "audio_playback.h"

using audio_playback::EffectId;
using audio_playback::effectIdFromByte;
using audio_playback::hasElapsed;
using audio_playback::kMaxPlaybackSamples;
using audio_playback::kPlaybackBufferBytes;
using audio_playback::kSampleRateHz;
using audio_playback::parsePlaybackBody;
using audio_playback::PcmRingBuffer;
using audio_playback::PlaybackBody;
using audio_playback::writePcmBytesLE;

void setUp() {}

void tearDown() {}

// ---- 定数が仕様どおりであること ----

static void test_constants_match_spec() {
    TEST_ASSERT_EQUAL_UINT32(24000, kSampleRateHz);
    TEST_ASSERT_EQUAL_size_t(720000, kMaxPlaybackSamples);  // 30秒 * 24kHz
    TEST_ASSERT_EQUAL_size_t(1440000, kPlaybackBufferBytes);
}

// ---- エフェクトID解釈（§3.3。未知値は通常応答へフォールバック） ----

static void test_effect_id_from_byte() {
    TEST_ASSERT_EQUAL(EffectId::kNormal, effectIdFromByte(0x00));
    TEST_ASSERT_EQUAL(EffectId::kCelebration, effectIdFromByte(0x01));
    TEST_ASSERT_EQUAL(EffectId::kNormal, effectIdFromByte(0x02));  // 未知
    TEST_ASSERT_EQUAL(EffectId::kNormal, effectIdFromByte(0xFF));
}

// ---- 0x03 BODY分解 ----

static void test_parse_body_extracts_effect_and_pcm() {
    const uint8_t body[] = {0x01, 0xAA, 0xBB, 0xCC, 0xDD};
    const PlaybackBody parsed = parsePlaybackBody(body, sizeof(body));
    TEST_ASSERT_TRUE(parsed.valid);
    TEST_ASSERT_EQUAL(EffectId::kCelebration, parsed.effectId);
    TEST_ASSERT_EQUAL_PTR(body + 1, parsed.pcmBytes);
    TEST_ASSERT_EQUAL_size_t(4, parsed.pcmByteCount);
}

// エフェクトIDのみ（PCMなし）のBODYを安全に扱うこと
static void test_parse_body_effect_only() {
    const uint8_t body[] = {0x00};
    const PlaybackBody parsed = parsePlaybackBody(body, sizeof(body));
    TEST_ASSERT_TRUE(parsed.valid);
    TEST_ASSERT_EQUAL(EffectId::kNormal, parsed.effectId);
    TEST_ASSERT_NULL(parsed.pcmBytes);
    TEST_ASSERT_EQUAL_size_t(0, parsed.pcmByteCount);
}

// 空BODY（エフェクトID欠落）は不正として拒否すること
static void test_parse_body_empty_is_invalid() {
    const PlaybackBody parsed = parsePlaybackBody(nullptr, 0);
    TEST_ASSERT_FALSE(parsed.valid);
    TEST_ASSERT_NULL(parsed.pcmBytes);
    TEST_ASSERT_EQUAL_size_t(0, parsed.pcmByteCount);
}

static void test_parse_body_null_with_nonzero_size_is_invalid() {
    const PlaybackBody parsed = parsePlaybackBody(nullptr, 3);
    TEST_ASSERT_FALSE(parsed.valid);
}

// PCM16の奇数バイト長は不正として拒否すること
static void test_parse_body_odd_pcm_is_invalid() {
    const uint8_t body[] = {0x00, 0x01, 0x02, 0x03};
    const PlaybackBody parsed = parsePlaybackBody(body, sizeof(body));
    TEST_ASSERT_FALSE(parsed.valid);
}

// ---- リングバッファ: 基本の書き込み・読み出し ----

static void test_ring_write_then_read() {
    int16_t storage[8];
    PcmRingBuffer ring(storage, 8);
    TEST_ASSERT_TRUE(ring.isEmpty());

    const int16_t src[] = {1, 2, 3, 4, 5};
    TEST_ASSERT_EQUAL_size_t(5, ring.write(src, 5));
    TEST_ASSERT_EQUAL_size_t(5, ring.available());
    TEST_ASSERT_EQUAL_size_t(3, ring.freeSpace());

    int16_t out[5] = {};
    TEST_ASSERT_EQUAL_size_t(5, ring.read(out, 5));
    for (int i = 0; i < 5; ++i) {
        TEST_ASSERT_EQUAL_INT16(src[i], out[i]);
    }
    TEST_ASSERT_TRUE(ring.isEmpty());
}

// ---- リングバッファ: 満杯時は空きぶんだけ書き込むこと ----

static void test_ring_write_truncates_when_full() {
    int16_t storage[4];
    PcmRingBuffer ring(storage, 4);
    const int16_t src[] = {1, 2, 3, 4, 5, 6};
    TEST_ASSERT_EQUAL_size_t(4, ring.write(src, 6));  // 容量4ぶんのみ
    TEST_ASSERT_TRUE(ring.isFull());
    TEST_ASSERT_EQUAL_size_t(0, ring.write(src, 1));  // 満杯なら0
}

// ---- リングバッファ: 部分読み出しと残量 ----

static void test_ring_partial_read() {
    int16_t storage[8];
    PcmRingBuffer ring(storage, 8);
    const int16_t src[] = {10, 20, 30, 40};
    ring.write(src, 4);

    int16_t out[2] = {};
    TEST_ASSERT_EQUAL_size_t(2, ring.read(out, 2));
    TEST_ASSERT_EQUAL_INT16(10, out[0]);
    TEST_ASSERT_EQUAL_INT16(20, out[1]);
    TEST_ASSERT_EQUAL_size_t(2, ring.available());

    int16_t rest[8] = {};
    TEST_ASSERT_EQUAL_size_t(2, ring.read(rest, 8));  // 残り2だけ
    TEST_ASSERT_EQUAL_INT16(30, rest[0]);
    TEST_ASSERT_EQUAL_INT16(40, rest[1]);
}

// ---- リングバッファ: 回り込み（wraparound）で正しく読み書きすること ----

static void test_ring_wraparound() {
    int16_t storage[4];
    PcmRingBuffer ring(storage, 4);
    // 3書いて2読み、head/tailを進めてから回り込みを起こす
    const int16_t a[] = {1, 2, 3};
    ring.write(a, 3);
    int16_t tmp[2] = {};
    ring.read(tmp, 2);  // head=2, 残り{3}

    const int16_t b[] = {4, 5, 6};  // tail=3から書くと末尾1＋先頭2へ回り込む
    TEST_ASSERT_EQUAL_size_t(3, ring.write(b, 3));
    TEST_ASSERT_EQUAL_size_t(4, ring.available());

    int16_t out[4] = {};
    TEST_ASSERT_EQUAL_size_t(4, ring.read(out, 4));
    const int16_t expected[] = {3, 4, 5, 6};
    for (int i = 0; i < 4; ++i) {
        TEST_ASSERT_EQUAL_INT16(expected[i], out[i]);
    }
}

// ---- リングバッファ: clearで空になること ----

static void test_ring_clear() {
    int16_t storage[4];
    PcmRingBuffer ring(storage, 4);
    const int16_t src[] = {1, 2, 3};
    ring.write(src, 3);
    ring.clear();
    TEST_ASSERT_TRUE(ring.isEmpty());
    TEST_ASSERT_EQUAL_size_t(4, ring.freeSpace());
    // clear後も書き込み・読み出しが正常に続くこと
    ring.write(src, 2);
    int16_t out[2] = {};
    TEST_ASSERT_EQUAL_size_t(2, ring.read(out, 2));
    TEST_ASSERT_EQUAL_INT16(1, out[0]);
}

// ---- リングバッファ: 空入力・nullptrを安全に扱うこと ----

static void test_ring_null_and_zero_are_safe() {
    int16_t storage[4];
    PcmRingBuffer ring(storage, 4);
    const int16_t src[] = {1};
    TEST_ASSERT_EQUAL_size_t(0, ring.write(nullptr, 3));
    TEST_ASSERT_EQUAL_size_t(0, ring.write(src, 0));
    int16_t out[4] = {};
    TEST_ASSERT_EQUAL_size_t(0, ring.read(nullptr, 3));
    TEST_ASSERT_EQUAL_size_t(0, ring.read(out, 0));
    TEST_ASSERT_TRUE(ring.isEmpty());
}

// ---- setBufferで束縛・リセットされること ----

static void test_ring_setbuffer_rebinds_and_resets() {
    PcmRingBuffer ring(nullptr, 0);  // 実機のbegin()前
    const int16_t src[] = {1, 2};
    TEST_ASSERT_EQUAL_size_t(0, ring.write(src, 2));  // 未束縛なら書けない

    int16_t storage[4];
    ring.setBuffer(storage, 4);
    TEST_ASSERT_EQUAL_size_t(2, ring.write(src, 2));
    TEST_ASSERT_EQUAL_size_t(2, ring.available());
    // 再束縛で状態リセット
    ring.setBuffer(storage, 4);
    TEST_ASSERT_TRUE(ring.isEmpty());
}

// ---- LE PCMバイト→サンプル変換書き込み ----

static void test_write_pcm_bytes_le_converts() {
    int16_t storage[8];
    PcmRingBuffer ring(storage, 8);
    // 0x0201=513, 0xFFFF=-1, 0x8000=-32768
    const uint8_t bytes[] = {0x01, 0x02, 0xFF, 0xFF, 0x00, 0x80};
    TEST_ASSERT_EQUAL_size_t(3, writePcmBytesLE(ring, bytes, sizeof(bytes)));

    int16_t out[3] = {};
    ring.read(out, 3);
    TEST_ASSERT_EQUAL_INT16(513, out[0]);
    TEST_ASSERT_EQUAL_INT16(-1, out[1]);
    TEST_ASSERT_EQUAL_INT16(-32768, out[2]);
}

// 奇数長PCMは全体を拒否し、リングへ書き込まないこと
static void test_write_pcm_bytes_le_rejects_odd_length() {
    int16_t storage[8];
    PcmRingBuffer ring(storage, 8);
    const uint8_t bytes[] = {0x01, 0x00, 0x02, 0x00, 0x7F};  // 末尾1バイト余り
    TEST_ASSERT_EQUAL_size_t(0, writePcmBytesLE(ring, bytes, sizeof(bytes)));
    TEST_ASSERT_TRUE(ring.isEmpty());
}

// バイト数が1未満・nullptrは0を返すこと
static void test_write_pcm_bytes_le_edge_cases() {
    int16_t storage[8];
    PcmRingBuffer ring(storage, 8);
    const uint8_t one[] = {0x01};
    TEST_ASSERT_EQUAL_size_t(0, writePcmBytesLE(ring, one, 1));  // 1バイトはサンプル未満
    TEST_ASSERT_EQUAL_size_t(0, writePcmBytesLE(ring, nullptr, 4));
}

// リング容量を超える変換は書けたぶんだけ返すこと（256サンプル境界の分割ループも通す）
static void test_write_pcm_bytes_le_truncates_to_capacity() {
    std::vector<int16_t> storage(300);
    PcmRingBuffer ring(storage.data(), 300);
    std::vector<uint8_t> bytes(700 * 2, 0);  // 700サンプルぶん
    TEST_ASSERT_EQUAL_size_t(300, writePcmBytesLE(ring, bytes.data(), bytes.size()));
    TEST_ASSERT_TRUE(ring.isFull());
}

// ---- 再生進捗タイムアウトが境界値とuint32_t周回後も正しいこと ----

static void test_elapsed_time_boundary() {
    TEST_ASSERT_FALSE(hasElapsed(1000, 1999, 1000));
    TEST_ASSERT_TRUE(hasElapsed(1000, 2000, 1000));
}

static void test_elapsed_time_handles_timer_wraparound() {
    constexpr uint32_t start = UINT32_MAX - 10;
    TEST_ASSERT_FALSE(hasElapsed(start, 8, 20));
    TEST_ASSERT_TRUE(hasElapsed(start, 9, 20));
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_constants_match_spec);
    RUN_TEST(test_effect_id_from_byte);
    RUN_TEST(test_parse_body_extracts_effect_and_pcm);
    RUN_TEST(test_parse_body_effect_only);
    RUN_TEST(test_parse_body_empty_is_invalid);
    RUN_TEST(test_parse_body_null_with_nonzero_size_is_invalid);
    RUN_TEST(test_parse_body_odd_pcm_is_invalid);
    RUN_TEST(test_ring_write_then_read);
    RUN_TEST(test_ring_write_truncates_when_full);
    RUN_TEST(test_ring_partial_read);
    RUN_TEST(test_ring_wraparound);
    RUN_TEST(test_ring_clear);
    RUN_TEST(test_ring_null_and_zero_are_safe);
    RUN_TEST(test_ring_setbuffer_rebinds_and_resets);
    RUN_TEST(test_write_pcm_bytes_le_converts);
    RUN_TEST(test_write_pcm_bytes_le_rejects_odd_length);
    RUN_TEST(test_write_pcm_bytes_le_edge_cases);
    RUN_TEST(test_write_pcm_bytes_le_truncates_to_capacity);
    RUN_TEST(test_elapsed_time_boundary);
    RUN_TEST(test_elapsed_time_handles_timer_wraparound);
    return UNITY_END();
}
