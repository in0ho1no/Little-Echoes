"""シリアルポート経由でマイコンと通信するTransport実装(pyserial使用)。docs/SPEC.md §3.2, §7.2-1 参照。

ESP32-S3のネイティブUSB CDCを使用するため、ボーレートは名目値であり実効速度に影響しない
(docs/SPEC.md §3.2)。

受信は専用のリーダースレッドが行う。スレッドは`serial.Serial`本体のread()タイムアウト
(`READ_POLL_INTERVAL_SEC`)ごとにブロッキングreadを発行し続け、届いたバイト列を内部バッファへ
蓄積する。`recv_packet()`はそのバッファからパケットを組み立てて返すだけで、シリアルポートへは
直接触れない。

リーダースレッドを常駐させる理由(task8実機結合で確定した必須要件。docs/task8_verification.md G):
Windowsのusbserドライバは、アプリケーションの読み取り要求(ReadFile)が滞留している間だけ
USB IN転送を活発にスケジュールする。`recv_packet(timeout=0)`のポーリングだけで受信すると、
ポーリングの隙間にデバイスがNAK待ちになる瞬間が大量に生じ、デバイス側USBスタック
(arduino-esp32 2.0.17同梱TinyUSBのdcd_esp32sx)の既知の不具合を誘発して、大きな送信
(録音0x01)の末尾が永久に届かなくなる。ブロッキングreadを常時滞留させることで、アプリ側の
ポーリング間隔とは無関係に受信が途切れないようにする(実測: ポーリング受信では60往復中43失敗、
ブロッキングread常駐では616往復全成功)。

`recv_packet(timeout=0)`は`MemoryTransport`と同じ契約(内部バッファにあるパケットを即座に返し、
なければ即Noneを返す。ブロッキングしない)を満たす(タスク10のasyncio多重待機が
ノンブロッキングポーリング前提のため)。リーダースレッドがシリアル例外(切断等)を検知した場合は、
次の`recv_packet()`呼び出しでその例外を送出する(切断時の明確なエラー終了を維持する)。
"""

import threading
import time
from typing import Protocol

import serial

from transport.base import Transport
from transport.packet import Packet, PacketParser, encode_packet

DEFAULT_BAUDRATE = 115200
"""ESP32-S3のネイティブUSB CDC使用時は名目値(docs/SPEC.md §3.2)。"""

READ_POLL_INTERVAL_SEC = 0.05
"""pyserial本体のread()タイムアウト秒数。リーダースレッドの1回のブロッキングread上限であり、
close()要求への応答遅延の上限でもある。"""

WRITE_TIMEOUT_SEC = 5.0
"""シリアル送信のタイムアウト秒数。実機切断時もイベントループを無期限に停止させない。"""

READER_CHUNK_BYTES = 65536
"""リーダースレッドが1回のread()で要求する最大バイト数。"""

_RECV_WAIT_STEP_SEC = 0.05
"""recv_packet(timeout>0)が新着通知を待つ1回あたりの上限秒数。"""


class SerialLike(Protocol):
    """SerialTransportが要求する`serial.Serial`の最小インターフェース(テストDI用)。"""

    def read(self, size: int = -1, /) -> bytes:
        """最大sizeバイトを読み取る(読み取れなければタイムアウトまで待ってから返す)。"""
        ...

    def write(self, b: bytes, /) -> int | None:
        """バイト列を送信する。"""
        ...

    def close(self) -> None:
        """接続を閉じる。"""
        ...


class SerialTransport(Transport):
    """pyserialの`Serial`をラップし、パケット単位の送受信を提供するTransport。

    受信はリーダースレッド(モジュールdocstring参照)が担う。`recv_packet()`と
    `send_packet()`は同一スレッド(通常はasyncioイベントループのスレッド)から
    呼び出す想定で、相互のスレッド安全性はリーダースレッドとの間でのみ保証する。
    """

    def __init__(self, serial_connection: SerialLike) -> None:
        """SerialTransportを初期化し、リーダースレッドを開始する。

        Args:
            serial_connection: オープン済みのシリアル接続。`read()`のtimeoutは
                `READ_POLL_INTERVAL_SEC`相当の短い値に設定されている必要がある
                (`open_serial_transport()`経由で生成する場合は自動的に満たされる)。
        """
        self._serial = serial_connection
        self._parser = PacketParser()
        self._pending: list[Packet] = []
        self._closed = False
        self._rx_lock = threading.Lock()
        self._rx_buffer = bytearray()
        self._rx_event = threading.Event()
        self._reader_error: BaseException | None = None
        self._stop_reader = threading.Event()
        self._reader = threading.Thread(target=self._reader_loop, name='serial-reader', daemon=True)
        self._reader.start()

    def send_packet(self, cmd: int, body: bytes = b'') -> None:
        """パケットをエンコードしてシリアルポートへ書き込む。

        Raises:
            RuntimeError: close() 済みのTransportに対して呼び出した場合。
        """
        if self._closed:
            raise RuntimeError('Transport is closed')
        packet = encode_packet(cmd, body)
        written = self._serial.write(packet)
        if written != len(packet):
            raise serial.SerialTimeoutException(f'Incomplete serial write: {written!r}/{len(packet)} bytes')

    def recv_packet(self, timeout: float | None = None) -> Packet | None:
        """受信バッファからパケットをデコードして返す。

        Raises:
            RuntimeError: close() 済みのTransportに対して呼び出した場合。
            serial.SerialException: リーダースレッドがシリアル例外(切断等)を検知していた場合。
        """
        if self._closed:
            raise RuntimeError('Transport is closed')
        if self._pending:
            return self._pending.pop(0)

        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            data = self._take_rx()
            if data:
                packets = self._parser.feed(data)
                if packets:
                    self._pending = packets
                    return self._pending.pop(0)
                continue  # 断片のみ。バッファが空になるまで読み進める

            if self._reader_error is not None:
                raise self._reader_error

            # 新しいデータが来ない間も、途中で途切れたBODYをタイムアウトで破棄する。
            self._parser.poll_timeout()

            if timeout == 0:
                return None
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return None
            self._rx_event.clear()
            self._rx_event.wait(_RECV_WAIT_STEP_SEC if remaining is None else min(_RECV_WAIT_STEP_SEC, remaining))

    def close(self) -> None:
        """リーダースレッドを止め、シリアルポートを閉じる。以後の send/recv はエラーになる。"""
        self._closed = True
        self._pending.clear()
        self._stop_reader.set()
        # close()でブロッキング中のread()を解除する(pyserialはハンドル無効の例外で返る)。
        self._serial.close()
        self._reader.join(timeout=1.0)

    def _take_rx(self) -> bytes:
        """リーダースレッドが蓄積したバイト列をすべて取り出す。"""
        with self._rx_lock:
            if not self._rx_buffer:
                return b''
            data = bytes(self._rx_buffer)
            self._rx_buffer.clear()
            return data

    def _reader_loop(self) -> None:
        """ブロッキングreadを発行し続け、受信バイト列を内部バッファへ蓄積する。

        モジュールdocstring参照: 読み取り要求を常時滞留させること自体が目的のため、
        受信データの有無にかかわらずread()を呼び続ける。
        """
        while not self._stop_reader.is_set():
            try:
                chunk = self._serial.read(READER_CHUNK_BYTES)
            except Exception as exc:
                if not self._stop_reader.is_set():
                    self._reader_error = exc
                    self._rx_event.set()
                return
            if chunk:
                with self._rx_lock:
                    self._rx_buffer.extend(chunk)
                self._rx_event.set()
            else:
                # 実機のread()はタイムアウトまでブロックするが、テスト用フェイクが即時に
                # 空を返してもホットループにならないよう最小限の待機を入れる。
                time.sleep(0.001)


def open_serial_transport(
    port: str,
    *,
    baudrate: int = DEFAULT_BAUDRATE,
    read_poll_interval: float = READ_POLL_INTERVAL_SEC,
    write_timeout: float = WRITE_TIMEOUT_SEC,
) -> SerialTransport:
    """指定ポートをオープンし、SerialTransportでラップして返す。

    Args:
        port: 接続先のシリアルポート名(例: "COM3")。
        baudrate: ボーレート。USB CDC使用時は名目値(docs/SPEC.md §3.2)。
        read_poll_interval: `serial.Serial`本体のread()タイムアウト秒数。
        write_timeout: `serial.Serial`本体のwrite()タイムアウト秒数。

    Returns:
        オープン済みの SerialTransport。

    Raises:
        serial.SerialException: ポートのオープンに失敗した場合。
    """
    connection = serial.Serial(port=port, baudrate=baudrate, timeout=read_poll_interval, write_timeout=write_timeout)
    return SerialTransport(connection)
