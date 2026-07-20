"""device.handshake のテスト。"""

import logging

import pytest

from device.handshake import wait_for_ready
from transport.memory_transport import create_memory_transport_pair
from transport.packet import Command


class TestWaitForReady:
    def test_returns_true_when_ready_already_queued(self) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.READY)

        result = wait_for_ready(pc, timeout=1.0)

        assert result.ready_received is True
        assert result.pending_recording is None

    def test_returns_false_and_logs_warning_on_timeout(self, caplog: pytest.LogCaptureFixture) -> None:
        pc, _mcu = create_memory_transport_pair()

        with caplog.at_level(logging.WARNING):
            result = wait_for_ready(pc, timeout=0.05)

        assert result.ready_received is False
        assert result.pending_recording is None
        assert any('READY not received' in record.message for record in caplog.records)

    def test_preserves_recording_then_finds_ready(self) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.RECORDED_AUDIO, b'pcm')
        mcu.send_packet(Command.READY)

        result = wait_for_ready(pc, timeout=1.0)

        assert result.ready_received is True
        assert result.pending_recording is not None
        assert result.pending_recording.cmd == Command.RECORDED_AUDIO
        assert result.pending_recording.body == b'pcm'

    def test_keeps_only_latest_recording(self) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.RECORDED_AUDIO, b'A')
        mcu.send_packet(Command.RECORDED_AUDIO, b'B')
        mcu.send_packet(Command.READY)

        result = wait_for_ready(pc, timeout=1.0)

        assert result.pending_recording is not None
        assert result.pending_recording.body == b'B'

    def test_cancel_clears_buffered_recording(self) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.RECORDED_AUDIO, b'A')
        mcu.send_packet(Command.CANCEL)
        mcu.send_packet(Command.READY)

        result = wait_for_ready(pc, timeout=1.0)

        assert result.pending_recording is None

    def test_recording_after_cancel_is_retained(self) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.RECORDED_AUDIO, b'A')
        mcu.send_packet(Command.CANCEL)
        mcu.send_packet(Command.RECORDED_AUDIO, b'B')
        mcu.send_packet(Command.READY)

        result = wait_for_ready(pc, timeout=1.0)

        assert result.pending_recording is not None
        assert result.pending_recording.body == b'B'

    def test_cancel_clears_recording_when_ready_times_out(self, caplog: pytest.LogCaptureFixture) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.RECORDED_AUDIO, b'A')
        mcu.send_packet(Command.CANCEL)

        with caplog.at_level(logging.WARNING):
            result = wait_for_ready(pc, timeout=0.1)

        assert result.ready_received is False
        assert result.pending_recording is None
        assert any('READY not received' in record.message for record in caplog.records)

    def test_discards_unexpected_packet_with_warning(self, caplog: pytest.LogCaptureFixture) -> None:
        pc, mcu = create_memory_transport_pair()
        mcu.send_packet(Command.ERROR)
        mcu.send_packet(Command.READY)

        with caplog.at_level(logging.WARNING):
            result = wait_for_ready(pc, timeout=1.0)

        assert result.pending_recording is None
        assert any('Discarding unexpected packet' in record.message for record in caplog.records)
