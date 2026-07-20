"""openai_client.canned_audio のテスト。"""

from pathlib import Path

import pytest

from openai_client.canned_audio import CannedAudio, EffectId, build_play_body
from transport.packet import MAX_BODY_SIZE


class TestBuildPlayBody:
    def test_body_starts_with_effect_id_byte(self) -> None:
        body = build_play_body(EffectId.THANKS, b'\x01\x02\x03\x04')
        assert body[0] == EffectId.THANKS
        assert body[1:] == b'\x01\x02\x03\x04'

    def test_normal_effect_id(self) -> None:
        body = build_play_body(EffectId.NORMAL, b'\xaa\xbb')
        assert body == b'\x00\xaa\xbb'

    def test_empty_pcm_produces_effect_id_only_body(self) -> None:
        body = build_play_body(EffectId.NORMAL, b'')
        assert body == b'\x00'

    @pytest.mark.parametrize('effect_id', [-1, 0x100])
    def test_rejects_effect_id_outside_byte_range(self, effect_id: int) -> None:
        with pytest.raises(ValueError, match='valid range'):
            build_play_body(effect_id, b'')

    def test_accepts_pcm_at_max_body_size(self) -> None:
        pcm = bytes(MAX_BODY_SIZE - 1)
        body = build_play_body(EffectId.NORMAL, pcm)
        assert len(body) == MAX_BODY_SIZE

    def test_rejects_pcm_exceeding_max_body_size(self) -> None:
        pcm = bytes(MAX_BODY_SIZE)
        with pytest.raises(ValueError, match='exceeds MAX_BODY_SIZE'):
            build_play_body(EffectId.NORMAL, pcm)


class TestCannedAudio:
    def test_loads_pcm_from_file(self, tmp_path: Path) -> None:
        pcm_path = tmp_path / 'thanks.pcm'
        pcm_path.write_bytes(b'\x00\x01\x02\x03')

        canned = CannedAudio(pcm_path)

        assert canned.pcm == b'\x00\x01\x02\x03'

    def test_raises_when_file_missing(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            CannedAudio(tmp_path / 'missing.pcm')

    def test_rejects_pcm_that_would_exceed_max_body_size(self, tmp_path: Path) -> None:
        pcm_path = tmp_path / 'oversized.pcm'
        pcm_path.write_bytes(bytes(MAX_BODY_SIZE))

        with pytest.raises(ValueError, match='exceeds MAX_BODY_SIZE'):
            CannedAudio(pcm_path)

    def test_loaded_pcm_can_be_used_for_play_body(self, tmp_path: Path) -> None:
        pcm_path = tmp_path / 'thanks.pcm'
        pcm_path.write_bytes(b'\x10\x20')

        canned = CannedAudio(pcm_path)
        body = build_play_body(EffectId.THANKS, canned.pcm)

        assert body == b'\x01\x10\x20'
