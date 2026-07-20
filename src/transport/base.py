"""マイコン-PC間のパケット送受信を抽象化する Transport インターフェース。

docs/SPEC.md §9 に基づく。通信部をこの抽象に依存させておくことで、
実装（USBシリアル / 将来のWi-Fi等）をパイプライン側の変更なしに差し替え可能にする。
"""

from abc import ABC, abstractmethod

from transport.packet import Packet


class Transport(ABC):
    """パケット送受信の抽象インターフェース。"""

    @abstractmethod
    def send_packet(self, cmd: int, body: bytes = b'') -> None:
        """パケットを送信する。

        Args:
            cmd: 制御命令（0〜255）。
            body: ボディデータ。省略時は空（SIZE=0）。
        """
        ...

    @abstractmethod
    def recv_packet(self, timeout: float | None = None) -> Packet | None:
        """パケットを受信する。

        Args:
            timeout: 受信を待つ最大秒数。None の場合は無期限に待つ。

        Returns:
            受信したパケット。timeout秒以内に受信できなかった場合は None。
        """
        ...

    @abstractmethod
    def close(self) -> None:
        """Transportが保持するリソースを解放する。"""
        ...
