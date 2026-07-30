"""COMポート自動検出。docs/SPEC.md §7.2-1 参照。

VID `0x303A`（Espressif）のポートを検索して自動接続する。該当が複数または0件の場合は
候補一覧を表示してユーザーに選択させる。
"""

from collections.abc import Callable, Sequence

from serial.tools import list_ports
from serial.tools.list_ports_common import ListPortInfo

ESPRESSIF_VID = 0x303A

PortLister = Callable[[], Sequence[ListPortInfo]]
PortChooser = Callable[[Sequence[ListPortInfo]], ListPortInfo]


class NoPortAvailableError(Exception):
    """選択可能なシリアルポートが1つも見つからなかった場合に送出される。"""


def _filter_candidate_ports(ports: Sequence[ListPortInfo]) -> list[ListPortInfo]:
    """ポート一覧からEspressifのVIDに一致するものを抽出する。"""
    return [port for port in ports if port.vid == ESPRESSIF_VID]


def find_candidate_ports(port_lister: PortLister = list_ports.comports) -> list[ListPortInfo]:
    """VID `0x303A`（Espressif）に一致するポートを列挙する。

    Args:
        port_lister: ポート一覧を返す関数。テスト時は差し替え可能。

    Returns:
        VIDが一致したポート情報のリスト。
    """
    return _filter_candidate_ports(port_lister())


def select_port(port_lister: PortLister = list_ports.comports, chooser: PortChooser | None = None) -> ListPortInfo:
    """接続先ポートを1つ決定する。

    VID一致が1件ならそれを自動選択する。0件または複数件の場合は、候補一覧
    （0件時は port_lister が返す全ポート）を `chooser` に渡してユーザーに選ばせる。

    Args:
        port_lister: ポート一覧を返す関数。テスト時は差し替え可能。
        chooser: 候補が0件/複数件のときに呼び出す選択関数。省略時は
            標準入出力を使った対話的選択（`prompt_user_to_choose_port`）を使う。

    Returns:
        選択されたポート情報。

    Raises:
        NoPortAvailableError: 選択可能なポートが1つも見つからない場合。
    """
    all_ports = list(port_lister())
    candidates = _filter_candidate_ports(all_ports)
    if len(candidates) == 1:
        return candidates[0]

    fallback_candidates = candidates if candidates else all_ports
    if not fallback_candidates:
        raise NoPortAvailableError('接続可能なシリアルポートが見つかりませんでした。')

    resolved_chooser = chooser if chooser is not None else prompt_user_to_choose_port
    return resolved_chooser(fallback_candidates)


def prompt_user_to_choose_port(candidates: Sequence[ListPortInfo]) -> ListPortInfo:
    """標準入出力を使って候補からポートを選ばせる。

    Args:
        candidates: 選択肢となるポート情報のリスト（1件以上を想定）。

    Returns:
        ユーザーが選択したポート情報。
    """
    print('接続先を自動判別できませんでした。候補から選択してください:')
    for i, port in enumerate(candidates):
        print(f'  [{i}] {port.device} - {port.description}')

    while True:
        raw = input(f'番号を入力 (0-{len(candidates) - 1}): ')
        try:
            index = int(raw)
        except ValueError:
            print('数値を入力してください。')
            continue
        if 0 <= index < len(candidates):
            return candidates[index]
        print('範囲外です。')
