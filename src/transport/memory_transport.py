"""マイコン実機の代わりにインメモリで通信を模擬する Transport 実装。

マイコンを接続しなくても、パケット送受信・接続ハンドシェイク・パイプライン全体を
テストできるようにするためのテスト用実装。`create_memory_transport_pair()` で
生成した2つのインスタンスは、片方の送信がもう片方の受信になる関係を持つ。
"""

import queue
import time

from transport.base import Transport
from transport.packet import Packet, PacketParser, encode_packet


class MemoryTransport(Transport):
    """キューを介してペアの相手とパケットをやり取りするTransport。"""

    def __init__(self, send_queue: queue.Queue[bytes], recv_queue: queue.Queue[bytes]) -> None:
        """送受信に使うキューを設定する。

        Args:
            send_queue: 送信したバイト列を書き込むキュー。
            recv_queue: 相手から届いたバイト列を読み取るキュー。
        """
        self._send_queue = send_queue
        self._recv_queue = recv_queue
        self._parser = PacketParser()
        self._pending: list[Packet] = []
        self._closed = False

    def send_packet(self, cmd: int, body: bytes = b'') -> None:
        """パケットをエンコードし、送信キューへ書き込む。

        Raises:
            RuntimeError: close() 済みのTransportに対して呼び出した場合。
        """
        if self._closed:
            raise RuntimeError('Transport is closed')
        self._send_queue.put(encode_packet(cmd, body))

    def recv_packet(self, timeout: float | None = None) -> Packet | None:
        """受信キューからバイト列を読み取り、パケットへデコードして返す。

        キューに複数パケット分のバイト列が溜まっている場合は、デコード済みの
        パケットを内部に保持しておき、次回呼び出し時にそこから返す。

        Raises:
            RuntimeError: close() 済みのTransportに対して呼び出した場合。
        """
        if self._closed:
            raise RuntimeError('Transport is closed')
        if self._pending:
            return self._pending.pop(0)

        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            remaining = None if deadline is None else deadline - time.monotonic()
            nonblocking = timeout == 0
            if not nonblocking and remaining is not None and remaining <= 0:
                self._parser.poll_timeout()
                return None
            try:
                chunk = self._recv_queue.get_nowait() if nonblocking else self._recv_queue.get(timeout=remaining)
            except queue.Empty:
                self._parser.poll_timeout()
                return None
            packets = self._parser.feed(chunk)
            if packets:
                self._pending = packets
                return self._pending.pop(0)
            self._parser.poll_timeout()

    def close(self) -> None:
        """Transportを閉じる。以後の send_packet/recv_packet はエラーになる。"""
        self._closed = True
        self._pending.clear()


def create_memory_transport_pair() -> tuple[MemoryTransport, MemoryTransport]:
    """相互に接続された2つの MemoryTransport を生成する。

    片方をPC側、もう片方をマイコン役（テスト用のFake）として使うことを想定している。

    Returns:
        (transport_a, transport_b) のタプル。aの送信はbの受信になり、その逆も同様。
    """
    queue_a_to_b: queue.Queue[bytes] = queue.Queue()
    queue_b_to_a: queue.Queue[bytes] = queue.Queue()
    transport_a = MemoryTransport(send_queue=queue_a_to_b, recv_queue=queue_b_to_a)
    transport_b = MemoryTransport(send_queue=queue_b_to_a, recv_queue=queue_a_to_b)
    return transport_a, transport_b
