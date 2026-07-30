"""transport.serial_transport のテスト。

実機は使わず、`SerialLike`を満たす`FakeSerial`でシリアル接続を模擬する。
受信はリーダースレッドが担うため、「投入したデータが見えること」の検証には
ブロッキング付きの`recv_packet(timeout=...)`を使う（スレッドの取り込みタイミングに
依存する即時性は契約に含めない）。`timeout=0`の非ブロッキング契約は
「何も届いていなければ即None」を検証する。
"""

import time
from typing import Any

import pytest
import serial

from transport.packet import Command, encode_packet
from transport.serial_transport import DEFAULT_BAUDRATE, READ_POLL_INTERVAL_SEC, WRITE_TIMEOUT_SEC, SerialTransport, open_serial_transport


class FakeSerial:
    """SerialLikeを満たすテスト用フェイク。バイト列バッファで送受信を模擬する。"""

    def __init__(self) -> None:
        """送受信バッファと呼び出し記録を初期化する。"""
        self._incoming = bytearray()
        self.written: list[bytes] = []
        self.reported_write_size: int | None = None
        self.read_error: Exception | None = None
        self.closed = False

    def push_incoming(self, data: bytes) -> None:
        """テストコードから「マイコンが送ってきたバイト列」を追加する。"""
        self._incoming.extend(data)

    def read(self, size: int = 1) -> bytes:
        if self.read_error is not None:
            raise self.read_error
        if self.closed:
            raise serial.SerialException('port is closed')
        if not self._incoming:
            # 実機のread()同様、データがなければ短時間ブロックすることを模擬する。
            time.sleep(0.005)
            return b''
        chunk = bytes(self._incoming[:size])
        del self._incoming[:size]
        return chunk

    def write(self, data: bytes) -> int | None:
        self.written.append(bytes(data))
        return len(data) if self.reported_write_size is None else self.reported_write_size

    def close(self) -> None:
        self.closed = True


class TestSendPacket:
    def test_writes_encoded_packet(self) -> None:
        fake = FakeSerial()
        transport = SerialTransport(fake)

        transport.send_packet(Command.ACCEPT_PROCESSING)

        assert fake.written == [encode_packet(Command.ACCEPT_PROCESSING)]
        transport.close()

    def test_raises_when_write_is_incomplete(self) -> None:
        fake = FakeSerial()
        fake.reported_write_size = 1
        transport = SerialTransport(fake)

        with pytest.raises(serial.SerialTimeoutException, match='Incomplete serial write'):
            transport.send_packet(Command.ACCEPT_PROCESSING)
        transport.close()

    def test_raises_after_close(self) -> None:
        fake = FakeSerial()
        transport = SerialTransport(fake)
        transport.close()

        with pytest.raises(RuntimeError):
            transport.send_packet(Command.READY)


class TestRecvPacket:
    def test_nonblocking_returns_none_when_nothing_arrived(self) -> None:
        fake = FakeSerial()
        transport = SerialTransport(fake)

        assert transport.recv_packet(timeout=0) is None
        transport.close()

    def test_returns_packet_pushed_before_construction(self) -> None:
        fake = FakeSerial()
        fake.push_incoming(encode_packet(Command.RECORDED_AUDIO, b'pcm'))
        transport = SerialTransport(fake)

        packet = transport.recv_packet(timeout=1.0)

        assert packet is not None
        assert packet.cmd == Command.RECORDED_AUDIO
        assert packet.body == b'pcm'
        transport.close()

    def test_blocking_with_timeout_returns_none_when_no_data_arrives(self) -> None:
        fake = FakeSerial()
        transport = SerialTransport(fake)

        assert transport.recv_packet(timeout=0.05) is None
        transport.close()

    def test_blocking_with_timeout_returns_packet_when_available(self) -> None:
        fake = FakeSerial()
        fake.push_incoming(encode_packet(Command.CANCEL))
        transport = SerialTransport(fake)

        packet = transport.recv_packet(timeout=1.0)

        assert packet is not None
        assert packet.cmd == Command.CANCEL
        transport.close()

    def test_none_timeout_returns_when_data_available(self) -> None:
        fake = FakeSerial()
        fake.push_incoming(encode_packet(Command.READY))
        transport = SerialTransport(fake)

        packet = transport.recv_packet(timeout=None)

        assert packet is not None
        assert packet.cmd == Command.READY
        transport.close()

    def test_multiple_packets_are_queued_and_nonblocking_pops_pending(self) -> None:
        fake = FakeSerial()
        fake.push_incoming(encode_packet(Command.READY) + encode_packet(Command.CANCEL))
        transport = SerialTransport(fake)

        first = transport.recv_packet(timeout=1.0)
        second = transport.recv_packet(timeout=0)  # pending済みは非ブロッキングで取れる

        assert first is not None
        assert first.cmd == Command.READY
        assert second is not None
        assert second.cmd == Command.CANCEL
        transport.close()

    def test_split_packet_across_two_pushes_reassembles(self) -> None:
        fake = FakeSerial()
        full = encode_packet(Command.RECORDED_AUDIO, b'0123456789')
        transport = SerialTransport(fake)

        fake.push_incoming(full[:5])
        assert transport.recv_packet(timeout=0.1) is None

        fake.push_incoming(full[5:])
        packet = transport.recv_packet(timeout=1.0)

        assert packet is not None
        assert packet.cmd == Command.RECORDED_AUDIO
        assert packet.body == b'0123456789'
        transport.close()

    def test_reader_error_propagates_to_recv(self) -> None:
        # 切断等でリーダースレッドがシリアル例外を検知したら、recv_packet が同じ例外を
        # 送出する（main.py の「切断＝明確なエラー終了」の挙動を維持する）。
        fake = FakeSerial()
        transport = SerialTransport(fake)
        fake.read_error = serial.SerialException('ClearCommError failed')

        with pytest.raises(serial.SerialException, match='ClearCommError failed'):
            transport.recv_packet(timeout=1.0)
        transport.close()

    def test_raises_after_close(self) -> None:
        fake = FakeSerial()
        transport = SerialTransport(fake)
        transport.close()

        with pytest.raises(RuntimeError):
            transport.recv_packet(timeout=0)


class TestClose:
    def test_closes_underlying_serial_and_stops_reader(self) -> None:
        fake = FakeSerial()
        transport = SerialTransport(fake)

        transport.close()

        assert fake.closed is True
        assert transport._reader.is_alive() is False

    def test_discards_pending_packets(self) -> None:
        fake = FakeSerial()
        fake.push_incoming(encode_packet(Command.READY) + encode_packet(Command.CANCEL))
        transport = SerialTransport(fake)
        transport.recv_packet(timeout=1.0)  # READYを取り出し、CANCELをpendingへ積む

        transport.close()

        assert fake.closed is True


class TestRealPyserialLoopback:
    """フェイクではなく実際の`serial.Serial`互換オブジェクト（loop://）で送受信の実挙動を確認する。

    `FakeSerial`はテスト用の簡略モデルであり、`read()`の実際のpyserial挙動を保証しない。
    `loop://`はTXをRXへ折り返す組み込みのループバックURLハンドラで、実機なしに
    本物の`serial.Serial`インターフェースを検証できる。
    """

    def test_round_trips_packet_through_real_serial_interface(self) -> None:
        connection = serial.serial_for_url('loop://', timeout=READ_POLL_INTERVAL_SEC)
        transport = None
        try:
            transport = SerialTransport(connection)
            transport.send_packet(Command.RECORDED_AUDIO, b'hello-loopback')

            packet = transport.recv_packet(timeout=1.0)

            assert packet is not None
            assert packet.cmd == Command.RECORDED_AUDIO
            assert packet.body == b'hello-loopback'
        finally:
            if transport is not None:
                transport.close()
            else:
                connection.close()


class TestOpenSerialTransport:
    def test_constructs_serial_with_expected_parameters(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}

        class FakeSerialConstructor:
            def __init__(self, *, port: str, baudrate: int, timeout: float, write_timeout: float) -> None:
                captured['port'] = port
                captured['baudrate'] = baudrate
                captured['timeout'] = timeout
                captured['write_timeout'] = write_timeout
                self._closed = False

            def read(self, size: int = 1) -> bytes:
                if self._closed:
                    raise serial.SerialException('port is closed')
                time.sleep(0.005)
                return b''

            def write(self, data: bytes) -> int | None:
                return len(data)

            def close(self) -> None:
                self._closed = True

        monkeypatch.setattr('transport.serial_transport.serial.Serial', FakeSerialConstructor)

        transport = open_serial_transport('COM3')

        assert isinstance(transport, SerialTransport)
        assert captured == {
            'port': 'COM3',
            'baudrate': DEFAULT_BAUDRATE,
            'timeout': READ_POLL_INTERVAL_SEC,
            'write_timeout': WRITE_TIMEOUT_SEC,
        }
        transport.close()
