// audio_record::AudioRecorder のホスト側ユニットテスト（§4.1の録音長制約と蓄積）。
// 実際のI2S録音・音質は実機確認の対象。ここでは蓄積・最短/最長判定・空入力安全性・
// 容量truncate・録音長算出といったハードウェア非依存ロジックを検証する。
#include <unity.h>

#include <cstdint>
#include <vector>

#include "audio_record.h"

using audio_record::AudioRecorder;
using audio_record::hasElapsed;
using audio_record::kMaxRecordingSamples;
using audio_record::kMinRecordingSamples;
using audio_record::kRecordBufferBytes;
using audio_record::kSampleRateHz;
using audio_record::RecorderError;
using audio_record::StopResult;

namespace {

// 録音バッファ（30秒ぶん）。各テストで使い回す。
std::vector<int16_t>& buffer() {
    static std::vector<int16_t> buf(kMaxRecordingSamples);
    return buf;
}

}  // namespace

void setUp() {}

void tearDown() {}

// ---- 定数（サンプル数・バッファサイズ）が仕様どおりであること ----

static void test_constants_match_spec() {
    TEST_ASSERT_EQUAL_UINT32(24000, kSampleRateHz);
    TEST_ASSERT_EQUAL_size_t(36000, kMinRecordingSamples);   // 1.5秒 * 24kHz
    TEST_ASSERT_EQUAL_size_t(720000, kMaxRecordingSamples);  // 30秒 * 24kHz
    TEST_ASSERT_EQUAL_size_t(1440000, kRecordBufferBytes);   // 720000 * 2byte ≈ 1.44MB
}

// ---- 開始直後は空 ----

static void test_starts_empty() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    TEST_ASSERT_TRUE(rec.isRecording());
    TEST_ASSERT_FALSE(rec.isFull());
    TEST_ASSERT_EQUAL_size_t(0, rec.sizeSamples());
    TEST_ASSERT_EQUAL_size_t(0, rec.sizeBytes());
    TEST_ASSERT_EQUAL_UINT32(0, rec.durationMs());
}

// ---- 追記でサンプルが蓄積され、内容がそのまま保持されること ----

static void test_append_accumulates_and_copies() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());

    const int16_t src[] = {10, -20, 30, -40};
    TEST_ASSERT_TRUE(rec.append(src, 4));
    TEST_ASSERT_EQUAL_size_t(4, rec.sizeSamples());
    TEST_ASSERT_EQUAL_size_t(8, rec.sizeBytes());  // 4 * 2byte

    const int16_t src2[] = {50, 60};
    TEST_ASSERT_TRUE(rec.append(src2, 2));
    TEST_ASSERT_EQUAL_size_t(6, rec.sizeSamples());

    const int16_t* data = rec.data();
    const int16_t expected[] = {10, -20, 30, -40, 50, 60};
    for (size_t i = 0; i < 6; ++i) {
        TEST_ASSERT_EQUAL_INT16(expected[i], data[i]);
    }
}

// ---- 空追記（count=0 / nullptr）は何もせず安全であること ----

static void test_append_empty_is_noop() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    TEST_ASSERT_TRUE(rec.append(nullptr, 0));  // 空マイク読み取りのnullptr対策
    TEST_ASSERT_EQUAL_size_t(0, rec.sizeSamples());

    const int16_t src[] = {7};
    rec.append(src, 1);
    TEST_ASSERT_TRUE(rec.append(nullptr, 0));
    TEST_ASSERT_EQUAL_size_t(1, rec.sizeSamples());
}

// ---- 最短録音長未満は破棄、境界ちょうどは保持（§4.1） ----

static void test_stop_below_min_is_discarded() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    std::vector<int16_t> src(kMinRecordingSamples - 1, 1);  // 1.5秒に1サンプル足りない
    rec.append(src.data(), src.size());
    TEST_ASSERT_EQUAL(StopResult::kDiscarded, rec.stop());
    TEST_ASSERT_FALSE(rec.isRecording());
}

static void test_stop_at_min_boundary_is_kept() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    std::vector<int16_t> src(kMinRecordingSamples, 1);  // ちょうど1.5秒
    rec.append(src.data(), src.size());
    TEST_ASSERT_EQUAL(StopResult::kKept, rec.stop());
}

// ---- 容量到達で自動停止し、超過分はtruncateされること（§4.1: 30秒強制終了） ----

static void test_auto_stops_at_max_capacity() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    std::vector<int16_t> src(kMaxRecordingSamples + 100, 2);  // 30秒＋α
    const bool stillRecording = rec.append(src.data(), src.size());
    TEST_ASSERT_FALSE(stillRecording);  // 追記直後に自動停止
    TEST_ASSERT_FALSE(rec.isRecording());
    TEST_ASSERT_TRUE(rec.isFull());
    TEST_ASSERT_EQUAL_size_t(kMaxRecordingSamples, rec.sizeSamples());  // 超過分は破棄
}

// 30秒到達（自動停止）した録音は「送信対象（kKept）」であること（破棄ではない）
static void test_max_recording_is_kept() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    std::vector<int16_t> src(kMaxRecordingSamples, 3);
    rec.append(src.data(), src.size());
    TEST_ASSERT_EQUAL(StopResult::kKept, rec.stop());
}

// ---- 停止後の追記は無視されること ----

static void test_append_after_stop_is_ignored() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    const int16_t src[] = {1, 2, 3};
    rec.append(src, 3);
    rec.stop();
    TEST_ASSERT_FALSE(rec.append(src, 3));
    TEST_ASSERT_EQUAL_size_t(3, rec.sizeSamples());  // 変化なし
}

// ---- 容量ぎりぎりでの追記が残容量ぶんだけ取り込むこと ----

static void test_append_truncates_to_remaining() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    std::vector<int16_t> first(kMaxRecordingSamples - 3, 1);
    TEST_ASSERT_TRUE(rec.append(first.data(), first.size()));

    const int16_t tail[] = {5, 6, 7, 8, 9};  // 残り3に対して5サンプル
    TEST_ASSERT_FALSE(rec.append(tail, 5));  // 3つ取り込み容量到達で停止
    TEST_ASSERT_EQUAL_size_t(kMaxRecordingSamples, rec.sizeSamples());
    const int16_t* data = rec.data();
    TEST_ASSERT_EQUAL_INT16(5, data[kMaxRecordingSamples - 3]);
    TEST_ASSERT_EQUAL_INT16(6, data[kMaxRecordingSamples - 2]);
    TEST_ASSERT_EQUAL_INT16(7, data[kMaxRecordingSamples - 1]);
}

// ---- 録音長（ミリ秒）がサンプル数から算出されること ----

static void test_duration_ms_from_samples() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    std::vector<int16_t> src(kSampleRateHz, 1);  // ちょうど1秒ぶん
    rec.append(src.data(), src.size());
    TEST_ASSERT_EQUAL_UINT32(1000, rec.durationMs());

    std::vector<int16_t> more(kSampleRateHz / 2, 1);  // さらに0.5秒
    rec.append(more.data(), more.size());
    TEST_ASSERT_EQUAL_UINT32(1500, rec.durationMs());
}

// ---- 再start・setBufferで状態がリセットされること ----

static void test_restart_resets_state() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    const int16_t src[] = {1, 2, 3, 4};
    rec.append(src, 4);
    TEST_ASSERT_TRUE(rec.start());  // 再開でクリア
    TEST_ASSERT_EQUAL_size_t(0, rec.sizeSamples());
    TEST_ASSERT_TRUE(rec.isRecording());
}

static void test_setbuffer_rebinds_and_resets() {
    AudioRecorder rec(nullptr, 0);  // 実機のbegin()前を模した未束縛状態
    rec.setBuffer(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    const int16_t src[] = {9, 8, 7};
    rec.append(src, 3);
    TEST_ASSERT_EQUAL_size_t(3, rec.sizeSamples());
    // 再束縛で状態リセット
    rec.setBuffer(buffer().data(), buffer().size());
    TEST_ASSERT_EQUAL_size_t(0, rec.sizeSamples());
    TEST_ASSERT_FALSE(rec.isRecording());
}

// ---- 未束縛バッファと不正な入力ポインターをエラーとして拒否すること ----

static void test_start_without_buffer_is_rejected() {
    AudioRecorder rec(nullptr, 0);
    TEST_ASSERT_FALSE(rec.start());
    TEST_ASSERT_FALSE(rec.isRecording());
    TEST_ASSERT_EQUAL(RecorderError::kBufferUnavailable, rec.lastError());
    TEST_ASSERT_EQUAL(StopResult::kError, rec.stop());
}

static void test_append_null_with_nonzero_count_is_rejected() {
    AudioRecorder rec(buffer().data(), buffer().size());
    TEST_ASSERT_TRUE(rec.start());
    TEST_ASSERT_FALSE(rec.append(nullptr, 1));
    TEST_ASSERT_FALSE(rec.isRecording());
    TEST_ASSERT_EQUAL(RecorderError::kInvalidInput, rec.lastError());
    TEST_ASSERT_EQUAL(StopResult::kError, rec.stop());
}

static void test_start_with_small_buffer_is_rejected() {
    int16_t smallBuffer[1] = {};
    AudioRecorder rec(smallBuffer, 1);
    TEST_ASSERT_FALSE(rec.start());
    TEST_ASSERT_EQUAL(RecorderError::kBufferTooSmall, rec.lastError());
    TEST_ASSERT_EQUAL(StopResult::kError, rec.stop());
}

// ---- 30秒の実時間判定が境界値とuint32_t周回後も正しいこと ----

static void test_elapsed_time_boundary() {
    TEST_ASSERT_FALSE(hasElapsed(1000, 30999, 30000));
    TEST_ASSERT_TRUE(hasElapsed(1000, 31000, 30000));
}

static void test_elapsed_time_handles_timer_wraparound() {
    constexpr uint32_t start = UINT32_MAX - 10;
    TEST_ASSERT_FALSE(hasElapsed(start, 8, 20));  // 経過19ms
    TEST_ASSERT_TRUE(hasElapsed(start, 9, 20));   // 経過20ms
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_constants_match_spec);
    RUN_TEST(test_starts_empty);
    RUN_TEST(test_append_accumulates_and_copies);
    RUN_TEST(test_append_empty_is_noop);
    RUN_TEST(test_stop_below_min_is_discarded);
    RUN_TEST(test_stop_at_min_boundary_is_kept);
    RUN_TEST(test_auto_stops_at_max_capacity);
    RUN_TEST(test_max_recording_is_kept);
    RUN_TEST(test_append_after_stop_is_ignored);
    RUN_TEST(test_append_truncates_to_remaining);
    RUN_TEST(test_duration_ms_from_samples);
    RUN_TEST(test_restart_resets_state);
    RUN_TEST(test_setbuffer_rebinds_and_resets);
    RUN_TEST(test_start_without_buffer_is_rejected);
    RUN_TEST(test_append_null_with_nonzero_count_is_rejected);
    RUN_TEST(test_start_with_small_buffer_is_rejected);
    RUN_TEST(test_elapsed_time_boundary);
    RUN_TEST(test_elapsed_time_handles_timer_wraparound);
    return UNITY_END();
}
