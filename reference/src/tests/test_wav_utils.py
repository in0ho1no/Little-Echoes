"""audio.wav_utils のテスト。"""

import wave
from io import BytesIO

import pytest

from audio.wav_utils import pcm_to_wav_bytes


def read_back(wav_bytes: bytes) -> tuple[int, int, int, bytes]:
    """WAVバイト列からヘッダ情報とフレームデータを読み戻す。"""
    with wave.open(BytesIO(wav_bytes), 'rb') as wav_file:
        params = (wav_file.getnchannels(), wav_file.getsampwidth(), wav_file.getframerate())
        frames = wav_file.readframes(wav_file.getnframes())
        return (*params, frames)


class TestPcmToWavBytes:
    def test_roundtrip_with_default_params(self) -> None:
        pcm_data = bytes(range(256)) * 4  # 16bit/monoとして偶数バイト長のダミーPCM
        wav_bytes = pcm_to_wav_bytes(pcm_data, sample_rate=16000)

        channels, sample_width, sample_rate, frames = read_back(wav_bytes)
        assert channels == 1
        assert sample_width == 2
        assert sample_rate == 16000
        assert frames == pcm_data

    def test_starts_with_riff_wave_markers(self) -> None:
        wav_bytes = pcm_to_wav_bytes(b'\x00\x01\x02\x03', sample_rate=16000)
        assert wav_bytes[:4] == b'RIFF'
        assert wav_bytes[8:12] == b'WAVE'

    def test_empty_pcm_produces_valid_zero_frame_wav(self) -> None:
        wav_bytes = pcm_to_wav_bytes(b'', sample_rate=16000)

        channels, sample_width, sample_rate, frames = read_back(wav_bytes)
        assert channels == 1
        assert sample_width == 2
        assert sample_rate == 16000
        assert frames == b''

    def test_custom_sample_rate_for_playback_direction(self) -> None:
        pcm_data = b'\x10\x20\x30\x40'
        wav_bytes = pcm_to_wav_bytes(pcm_data, sample_rate=24000)

        _channels, _sample_width, sample_rate, frames = read_back(wav_bytes)
        assert sample_rate == 24000
        assert frames == pcm_data

    def test_custom_sample_width_and_channels(self) -> None:
        pcm_data = b'\x00' * 12  # 8bit(1byte) x 2ch なら6フレーム分
        wav_bytes = pcm_to_wav_bytes(pcm_data, sample_rate=8000, sample_width=1, channels=2)

        channels, sample_width, sample_rate, frames = read_back(wav_bytes)
        assert channels == 2
        assert sample_width == 1
        assert sample_rate == 8000
        assert frames == pcm_data

    @pytest.mark.parametrize(
        ('pcm_data', 'sample_width', 'channels'),
        [
            (b'\x00', 2, 1),
            (b'\x00' * 6, 2, 2),
        ],
    )
    def test_rejects_pcm_data_not_aligned_to_frame_size(self, pcm_data: bytes, sample_width: int, channels: int) -> None:
        with pytest.raises(ValueError, match='not aligned to frame size'):
            pcm_to_wav_bytes(pcm_data, sample_rate=16000, sample_width=sample_width, channels=channels)

    @pytest.mark.parametrize('sample_width', [0, -1])
    def test_rejects_non_positive_sample_width(self, sample_width: int) -> None:
        with pytest.raises(ValueError, match='sample_width must be greater than zero'):
            pcm_to_wav_bytes(b'\x00\x00', sample_rate=16000, sample_width=sample_width)

    @pytest.mark.parametrize('channels', [0, -1])
    def test_rejects_non_positive_channels(self, channels: int) -> None:
        with pytest.raises(ValueError, match='channels must be greater than zero'):
            pcm_to_wav_bytes(b'\x00\x00', sample_rate=16000, channels=channels)
