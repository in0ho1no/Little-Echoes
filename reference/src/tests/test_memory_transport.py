"""transport.memory_transport のテスト。"""

import threading
import time

import pytest

from transport.memory_transport import create_memory_transport_pair
from transport.packet import Command


class TestMemoryTransport:
    def test_send_and_receive_single_packet(self) -> None:
        pc, mcu = create_memory_transport_pair()

        mcu.send_packet(Command.READY)
        packet = pc.recv_packet(timeout=1.0)

        assert packet is not None
        assert packet.cmd == Command.READY
        assert packet.body == b''

    def test_bidirectional_communication(self) -> None:
        pc, mcu = create_memory_transport_pair()

        mcu.send_packet(Command.RECORDED_AUDIO, b'PCM_DATA')
        pc.send_packet(Command.ACCEPT_PROCESSING)

        from_mcu = pc.recv_packet(timeout=1.0)
        from_pc = mcu.recv_packet(timeout=1.0)

        assert from_mcu is not None
        assert from_mcu.cmd == Command.RECORDED_AUDIO
        assert from_mcu.body == b'PCM_DATA'
        assert from_pc is not None
        assert from_pc.cmd == Command.ACCEPT_PROCESSING

    def test_multiple_packets_received_in_order(self) -> None:
        pc, mcu = create_memory_transport_pair()

        mcu.send_packet(Command.READY)
        mcu.send_packet(Command.RECORDED_AUDIO, b'A')
        mcu.send_packet(Command.CANCEL)

        received = [pc.recv_packet(timeout=1.0) for _ in range(3)]

        assert [p.cmd for p in received if p is not None] == [
            Command.READY,
            Command.RECORDED_AUDIO,
            Command.CANCEL,
        ]

    def test_recv_packet_returns_none_on_timeout_when_no_data(self) -> None:
        pc, _mcu = create_memory_transport_pair()

        started = time.monotonic()
        packet = pc.recv_packet(timeout=0.1)
        elapsed = time.monotonic() - started

        assert packet is None
        assert elapsed < 1.0

    def test_recv_packet_with_zero_timeout_receives_queued_packet(self) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.CANCEL)

        packet = pc.recv_packet(timeout=0)

        assert packet is not None
        assert packet.cmd == Command.CANCEL

    def test_recv_packet_with_zero_timeout_returns_none_when_empty(self) -> None:
        pc, _mcu = create_memory_transport_pair()

        assert pc.recv_packet(timeout=0) is None

    def test_recv_packet_blocks_until_data_arrives(self) -> None:
        pc, mcu = create_memory_transport_pair()

        def send_after_delay() -> None:
            time.sleep(0.1)
            mcu.send_packet(Command.READY)

        sender = threading.Thread(target=send_after_delay)
        sender.start()
        try:
            packet = pc.recv_packet(timeout=2.0)
        finally:
            sender.join()

        assert packet is not None
        assert packet.cmd == Command.READY

    def test_operations_after_close_raise(self) -> None:
        pc, _mcu = create_memory_transport_pair()

        pc.close()

        with pytest.raises(RuntimeError):
            pc.send_packet(Command.READY)
        with pytest.raises(RuntimeError):
            pc.recv_packet(timeout=0.1)
