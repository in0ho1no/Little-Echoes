"""debug_utils のテスト。"""

import logging
import wave
from datetime import datetime
from io import BytesIO
from pathlib import Path

import pytest

from debug_utils import log_response_summary, save_debug_recording


def read_wav(path: Path) -> tuple[int, int, int, bytes]:
    """WAVファイルからヘッダ情報とフレームデータを読み戻す。"""
    with wave.open(BytesIO(path.read_bytes()), 'rb') as wav_file:
        params = (wav_file.getnchannels(), wav_file.getsampwidth(), wav_file.getframerate())
        frames = wav_file.readframes(wav_file.getnframes())
        return (*params, frames)


class TestSaveDebugRecording:
    def test_saves_pcm_as_valid_wav(self, tmp_path: Path) -> None:
        pcm_data = bytes(range(256)) * 4
        timestamp = datetime(2026, 7, 12, 15, 30, 45, 123456)

        path = save_debug_recording(pcm_data, tmp_path, timestamp=timestamp)

        assert path.exists()
        channels, sample_width, sample_rate, frames = read_wav(path)
        assert channels == 1
        assert sample_width == 2
        assert sample_rate == 24000
        assert frames == pcm_data

    def test_filename_includes_timestamp(self, tmp_path: Path) -> None:
        timestamp = datetime(2026, 7, 12, 15, 30, 45, 123456)

        path = save_debug_recording(b'\x00\x01', tmp_path, timestamp=timestamp)

        assert path.name == 'recording_20260712_153045_123456.wav'

    def test_creates_missing_directory(self, tmp_path: Path) -> None:
        nested_dir = tmp_path / 'nested' / 'debug'

        path = save_debug_recording(b'\x00\x01', nested_dir, timestamp=datetime(2026, 7, 12, 0, 0, 0))

        assert path.exists()
        assert path.parent == nested_dir

    def test_uses_current_time_when_timestamp_omitted(self, tmp_path: Path) -> None:
        before = datetime.now()
        path = save_debug_recording(b'\x00\x01', tmp_path)
        after = datetime.now()

        recorded = datetime.strptime(path.stem.removeprefix('recording_'), '%Y%m%d_%H%M%S_%f')
        assert before <= recorded <= after


class TestLogResponseSummary:
    def test_logs_transcript_and_duration(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.INFO):
            log_response_summary('こんにちは', 1.23)

        assert any("transcript='こんにちは'" in record.message and 'duration=1.23s' in record.message for record in caplog.records)

    def test_logs_usage_when_provided(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.INFO):
            log_response_summary('hi', 0.5, usage={'input_tokens': 10, 'output_tokens': 20})

        assert any('input_tokens=10' in record.message and 'output_tokens=20' in record.message for record in caplog.records)

    def test_logs_na_when_usage_missing(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.INFO):
            log_response_summary(None, 0.1, usage=None)

        assert any('usage=[N/A]' in record.message for record in caplog.records)
