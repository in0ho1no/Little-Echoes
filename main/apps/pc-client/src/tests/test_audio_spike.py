"""Phase 1A音声スパイクの境界を確認する。"""

import wave
from pathlib import Path

import pytest
from audio.spike import (
    ByteRingBuffer,
    CaptureFormat,
    downsample_48k_to_24k,
    held_long_enough,
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


def test_hold_threshold_is_inclusive() -> None:
    """1.5秒ちょうどの長押しを成立とする。"""
    assert held_long_enough(10.0, 11.5)
    assert not held_long_enough(10.0, 11.499)


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
