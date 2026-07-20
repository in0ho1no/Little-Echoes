"""Phase 1A音声スパイクの境界を確認する。"""

import struct
import wave
from pathlib import Path

import pytest
from audio.spike import (
    HOLD_SECONDS,
    NORMALIZATION_TARGET_PEAK,
    POST_ROLL_SECONDS,
    PRE_ROLL_SECONDS,
    ByteRingBuffer,
    CaptureFormat,
    boost_quiet_pcm,
    downsample_48k_to_24k,
    parse_device,
    save_baseline_clip,
    write_wav,
)


def test_ring_buffer_keeps_latest_audio() -> None:
    """容量を超えた場合は末尾ブロックを保持する。"""
    buffer = ByteRingBuffer(CaptureFormat(sample_rate=2, channels=1, sample_width=1), seconds=2)
    buffer.append(b'ab')
    buffer.append(b'cd')
    buffer.append(b'ef')
    assert buffer.snapshot(4) == b'cdef'


def test_ring_buffer_keeps_full_capacity_when_block_crosses_boundary() -> None:
    """ブロック境界と容量が一致しなくても末尾容量分を保持する。"""
    buffer = ByteRingBuffer(CaptureFormat(sample_rate=3, channels=1, sample_width=1), seconds=1)
    buffer.append(b'ab')
    buffer.append(b'cdef')
    assert buffer.snapshot(3) == b'def'


def test_ring_buffer_trims_an_oversized_block() -> None:
    """単一ブロックが容量を超えても保持量は上限以内になる。"""
    buffer = ByteRingBuffer(CaptureFormat(sample_rate=2, channels=1, sample_width=1), seconds=2)
    buffer.append(b'abcdef')
    assert buffer.snapshot(10) == b'cdef'


def test_ring_buffer_clear_discards_previous_audio() -> None:
    """後続音声用に既存の音声を破棄できる。"""
    buffer = ByteRingBuffer(CaptureFormat(sample_rate=2, channels=1, sample_width=1), seconds=2)
    buffer.append(b'abcd')
    buffer.clear()
    assert buffer.snapshot(4) == b''


def test_recording_constants_match_spec() -> None:
    """長押し・前後録りの秒数はSPECの固定値と一致する。"""
    assert (HOLD_SECONDS, PRE_ROLL_SECONDS, POST_ROLL_SECONDS) == (1.5, 10, 5)


def test_parse_device_converts_numeric_id_only() -> None:
    """数値のCLI指定だけをsounddevice用の整数IDに変換する。"""
    assert parse_device('3') == 3
    assert parse_device('USB Microphone') == 'USB Microphone'


def test_downsample_averages_adjacent_samples() -> None:
    """48 kHzフォールバックは隣接サンプルの平均を使う。"""
    pcm = b'\x00\x00\x04\x00\xfc\xff\x00\x00'
    assert downsample_48k_to_24k(pcm) == b'\x02\x00\xfe\xff'


def test_downsample_rejects_incomplete_pair() -> None:
    """完全なサンプル対でないPCMを拒否する。"""
    with pytest.raises(ValueError, match='complete sample pairs'):
        downsample_48k_to_24k(b'\x00\x00')


def test_boost_quiet_pcm_raises_voice_level_with_a_bounded_gain() -> None:
    """小さい発話は最大8倍まで増幅する。"""
    pcm = b'\xe8\x03\x18\xfc'
    assert boost_quiet_pcm(pcm) == b'@\x1f\xc0\xe0'


def test_boost_quiet_pcm_does_not_raise_silence_or_loud_audio() -> None:
    """無音相当と十分大きい音声のレベルは変えない。"""
    assert boost_quiet_pcm(b'\x64\x00') == b'\x64\x00'
    assert boost_quiet_pcm(b'xi') == b'xi'


def test_boost_quiet_pcm_ignores_a_single_loud_outlier() -> None:
    """単発のキー音があっても、小さい発話を増幅し16-bit範囲へ収める。"""
    pcm = struct.pack('<100h', *([1_000] * 99), 30_000)
    adjusted: tuple[int, ...] = struct.unpack('<100h', boost_quiet_pcm(pcm))
    assert adjusted[0] == 8_000
    assert NORMALIZATION_TARGET_PEAK < adjusted[-1] <= 32_767


def test_boost_quiet_pcm_handles_a_short_word_among_silence() -> None:
    """短い発話が無音に埋もれても補正対象にする。"""
    pcm = struct.pack('<100h', *([0] * 96), *([1_000] * 4))
    adjusted: tuple[int, ...] = struct.unpack('<100h', boost_quiet_pcm(pcm))
    assert adjusted[-1] == 8_000


def test_write_wav_uses_baseline_format(tmp_path: Path) -> None:
    """保存WAVは24 kHz/16-bit/monoになる。"""
    output = tmp_path / 'clip.wav'
    write_wav(output, b'\x00\x00\x01\x00', CaptureFormat(24_000))
    with wave.open(str(output), 'rb') as wav_file:
        assert (wav_file.getframerate(), wav_file.getsampwidth(), wav_file.getnchannels(), wav_file.getnframes()) == (24_000, 2, 1, 2)


def test_save_baseline_clip_downsamples_fallback_input(tmp_path: Path) -> None:
    """48 kHz入力は保存時に24 kHzへ変換する。"""
    output = tmp_path / 'fallback.wav'
    save_baseline_clip(output, b'\x00\x00\x04\x00', CaptureFormat(48_000))
    with wave.open(str(output), 'rb') as wav_file:
        assert (wav_file.getframerate(), wav_file.getnframes()) == (24_000, 1)
