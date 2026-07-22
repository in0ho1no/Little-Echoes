"""manual_realtime_check のAPI非依存な安全保存処理のテスト。"""

from pathlib import Path
from typing import Any

import pytest

import scripts.manual_realtime_check as manual_realtime_check
from scripts.manual_realtime_check import _save_validated_canned_audio
from transport.packet import MAX_BODY_SIZE


class TestSaveValidatedCannedAudio:
    def test_atomically_replaces_existing_asset_after_validation(self, tmp_path: Path) -> None:
        output = tmp_path / 'canned_thanks.pcm'
        output.write_bytes(b'old-audio')

        _save_validated_canned_audio(b'\x00\x01\x02\x03', output)

        assert output.read_bytes() == b'\x00\x01\x02\x03'
        assert list(tmp_path.glob('*.tmp')) == []

    @pytest.mark.parametrize(
        ('invalid_pcm', 'message'),
        [(b'', 'is empty'), (b'\x00', 'not aligned')],
    )
    def test_rejects_empty_or_unaligned_pcm_and_preserves_existing_asset(self, tmp_path: Path, invalid_pcm: bytes, message: str) -> None:
        output = tmp_path / 'canned_thanks.pcm'
        output.write_bytes(b'old-audio')

        with pytest.raises(ValueError, match=message):
            _save_validated_canned_audio(invalid_pcm, output)

        assert output.read_bytes() == b'old-audio'
        assert list(tmp_path.glob('*.tmp')) == []

    def test_rejects_oversized_pcm_and_preserves_existing_asset(self, tmp_path: Path) -> None:
        output = tmp_path / 'canned_thanks.pcm'
        output.write_bytes(b'old-audio')

        with pytest.raises(ValueError, match='exceeds MAX_BODY_SIZE'):
            _save_validated_canned_audio(bytes(MAX_BODY_SIZE), output)

        assert output.read_bytes() == b'old-audio'
        assert list(tmp_path.glob('*.tmp')) == []

    def test_cleans_up_temp_file_when_write_itself_fails(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        output = tmp_path / 'canned_thanks.pcm'
        output.write_bytes(b'old-audio')
        real_named_temporary_file = manual_realtime_check.NamedTemporaryFile

        def failing_named_temporary_file(*args: Any, **kwargs: Any) -> Any:
            temporary_file = real_named_temporary_file(*args, **kwargs)

            def _raise(_data: bytes) -> int:
                raise OSError('disk full')

            monkeypatch.setattr(temporary_file, 'write', _raise)
            return temporary_file

        monkeypatch.setattr(manual_realtime_check, 'NamedTemporaryFile', failing_named_temporary_file)

        with pytest.raises(OSError, match='disk full'):
            _save_validated_canned_audio(b'\x00\x01\x02\x03', output)

        assert output.read_bytes() == b'old-audio'
        assert list(tmp_path.iterdir()) == [output]
