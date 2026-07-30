"""device.port_discovery のテスト。"""

from collections.abc import Sequence

import pytest
from serial.tools.list_ports_common import ListPortInfo

from device.port_discovery import (
    ESPRESSIF_VID,
    NoPortAvailableError,
    find_candidate_ports,
    prompt_user_to_choose_port,
    select_port,
)


def make_port(device: str, vid: int | None, description: str = 'dummy') -> ListPortInfo:
    """テスト用に ListPortInfo を組み立てる。

    存在しないCOMポート名で `os.path.islink()` を呼ぶと（実機探索のような扱いになり）
    Windowsで数秒〜十数秒待たされるため、`skip_link_detection=True` で回避する。
    """
    port = ListPortInfo(device, skip_link_detection=True)
    port.vid = vid
    port.description = description
    return port


class TestFindCandidatePorts:
    def test_filters_by_espressif_vid(self) -> None:
        ports = [
            make_port('COM1', vid=0x0403),
            make_port('COM2', vid=ESPRESSIF_VID),
            make_port('COM3', vid=None),
        ]
        candidates = find_candidate_ports(port_lister=lambda: ports)
        assert [p.device for p in candidates] == ['COM2']

    def test_returns_empty_list_when_no_match(self) -> None:
        ports = [make_port('COM1', vid=0x0403)]
        candidates = find_candidate_ports(port_lister=lambda: ports)
        assert candidates == []


class TestSelectPort:
    def test_auto_selects_single_match(self) -> None:
        ports = [make_port('COM1', vid=0x0403), make_port('COM2', vid=ESPRESSIF_VID)]

        def chooser_should_not_be_called(_candidates: Sequence[ListPortInfo]) -> ListPortInfo:
            raise AssertionError('chooserは呼ばれないはず')

        selected = select_port(port_lister=lambda: ports, chooser=chooser_should_not_be_called)
        assert selected.device == 'COM2'

    def test_calls_chooser_with_vid_matches_when_multiple(self) -> None:
        matches = [make_port('COM2', vid=ESPRESSIF_VID), make_port('COM4', vid=ESPRESSIF_VID)]
        ports = [make_port('COM1', vid=0x0403), *matches]
        received: list[ListPortInfo] = []

        def chooser(candidates: Sequence[ListPortInfo]) -> ListPortInfo:
            received.extend(candidates)
            return candidates[0]

        selected = select_port(port_lister=lambda: ports, chooser=chooser)
        assert [p.device for p in received] == ['COM2', 'COM4']
        assert selected.device == 'COM2'

    def test_calls_chooser_with_all_ports_when_no_vid_match(self) -> None:
        ports = [make_port('COM1', vid=0x0403), make_port('COM5', vid=0x1234)]
        received: list[ListPortInfo] = []

        def chooser(candidates: Sequence[ListPortInfo]) -> ListPortInfo:
            received.extend(candidates)
            return candidates[1]

        selected = select_port(port_lister=lambda: ports, chooser=chooser)
        assert [p.device for p in received] == ['COM1', 'COM5']
        assert selected.device == 'COM5'

    def test_lists_ports_only_once_when_no_vid_match(self) -> None:
        ports = [make_port('COM9', vid=0x0403)]
        call_count = 0

        def port_lister() -> list[ListPortInfo]:
            nonlocal call_count
            call_count += 1
            return ports

        selected = select_port(port_lister=port_lister, chooser=lambda candidates: candidates[0])

        assert selected.device == 'COM9'
        assert call_count == 1

    def test_raises_when_no_ports_at_all(self) -> None:
        def chooser_should_not_be_called(_candidates: Sequence[ListPortInfo]) -> ListPortInfo:
            raise AssertionError('chooserは呼ばれないはず')

        with pytest.raises(NoPortAvailableError):
            select_port(port_lister=lambda: [], chooser=chooser_should_not_be_called)


class TestPromptUserToChoosePort:
    def test_returns_selected_port_on_valid_index(self, monkeypatch: pytest.MonkeyPatch) -> None:
        ports = [make_port('COM1', vid=ESPRESSIF_VID), make_port('COM2', vid=ESPRESSIF_VID)]
        monkeypatch.setattr('builtins.input', lambda _prompt='': '1')

        selected = prompt_user_to_choose_port(ports)
        assert selected.device == 'COM2'

    def test_retries_on_invalid_then_out_of_range_then_valid_input(self, monkeypatch: pytest.MonkeyPatch) -> None:
        ports = [make_port('COM1', vid=ESPRESSIF_VID)]
        responses = iter(['abc', '5', '0'])
        monkeypatch.setattr('builtins.input', lambda _prompt='': next(responses))

        selected = prompt_user_to_choose_port(ports)
        assert selected.device == 'COM1'
