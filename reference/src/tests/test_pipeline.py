"""pipeline のテスト。

pytest-asyncioは未導入のため、非同期テストは asyncio.run() で直接駆動する。
マイコン役は `FakeMicrocontroller`（MemoryTransport越し）、Realtimeクライアントは
`FakeRealtimeClient`（`pipeline.RealtimeClientProtocol`を満たすフェイク）で模擬する。
"""

import asyncio
import logging
import queue
from pathlib import Path

import pytest

from openai_client.canned_audio import CannedAudio, EffectId, build_play_body
from openai_client.errors import ApiClientError
from openai_client.realtime_client import RealtimeError, RealtimeReply
from pipeline import process_one_event, run_pipeline
from transport.memory_transport import MemoryTransport, create_memory_transport_pair
from transport.packet import Command, Packet, encode_packet

FAST_IDLE_POLL_SEC = 0.02
FAST_CANCEL_POLL_SEC = 0.01


class FakeMicrocontroller:
    """MemoryTransport越しにマイコン役を模擬するテスト用ヘルパー。"""

    def __init__(self) -> None:
        """PC側・マイコン側のMemoryTransportペアを生成する。"""
        self.pc_transport, self._mcu_transport = create_memory_transport_pair()

    def send_recorded_audio(self, pcm: bytes) -> None:
        self._mcu_transport.send_packet(Command.RECORDED_AUDIO, pcm)

    def send_cancel(self) -> None:
        self._mcu_transport.send_packet(Command.CANCEL)

    def send_ready(self) -> None:
        self._mcu_transport.send_packet(Command.READY)

    def expect_packet(self, timeout: float = 1.0) -> Packet:
        packet = self._mcu_transport.recv_packet(timeout=timeout)
        assert packet is not None, 'パケットが届くはずが届かなかった'
        return packet

    def expect_no_packet(self, timeout: float = 0.05) -> None:
        assert self._mcu_transport.recv_packet(timeout=timeout) is None


class FakeRealtimeClient:
    """`pipeline.RealtimeClientProtocol` を満たすテスト用フェイク。"""

    def __init__(self) -> None:
        """呼び出し記録用の状態を初期化する。"""
        self.respond_calls: list[bytes] = []
        self.cancel_calls = 0
        self.idle_check_calls = 0
        self.playback_notes: list[float] = []
        self.reply: RealtimeReply | None = None
        self.error: ApiClientError | None = None
        self.release_event: asyncio.Event | None = None
        self.cancelled_during_wait = False

    async def respond_to_audio(self, pcm_bytes: bytes) -> RealtimeReply:
        self.respond_calls.append(pcm_bytes)
        if self.release_event is not None:
            try:
                await self.release_event.wait()
            except asyncio.CancelledError:
                self.cancelled_during_wait = True
                raise
        if self.error is not None:
            raise self.error
        assert self.reply is not None
        return self.reply

    async def note_playback_duration(self, playback_sec: float) -> None:
        self.playback_notes.append(playback_sec)

    async def check_idle_timeout(self) -> bool:
        self.idle_check_calls += 1
        return False

    async def cancel(self) -> None:
        self.cancel_calls += 1


def make_canned_audio(tmp_path: Path, pcm: bytes = b'\x10\x20') -> CannedAudio:
    path = tmp_path / 'thanks.pcm'
    path.write_bytes(pcm)
    return CannedAudio(path)


class TestNormalResponse:
    def test_sends_accept_then_play_audio_with_normal_effect(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript='hello')
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        accept = mcu.expect_packet()
        assert accept.cmd == Command.ACCEPT_PROCESSING
        play = mcu.expect_packet()
        assert play.cmd == Command.PLAY_AUDIO
        assert play.body == build_play_body(EffectId.NORMAL, b'REPLY_PCM')
        assert realtime.respond_calls == [b'RECORDED_PCM']
        # 0x03送信後、アイドル起点が再生時間（PCMバイト数÷48000）ぶん先送りされる。
        assert realtime.playback_notes == [len(b'REPLY_PCM') / 2 / 24000]
        mcu.expect_no_packet()


class TestThanksResponse:
    def test_sends_canned_audio_with_thanks_effect(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'IGNORED_REPLY', thanks_detected=True, transcript='ありがとう')
        canned_audio = make_canned_audio(tmp_path, pcm=b'\xaa\xbb\xcc')
        mcu.send_recorded_audio(b'RECORDED_PCM')

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        play = mcu.expect_packet()
        assert play.cmd == Command.PLAY_AUDIO
        assert play.body == build_play_body(EffectId.THANKS, b'\xaa\xbb\xcc')
        # 定型応答（感謝）でも再生時間ぶんアイドル起点が先送りされる。
        assert realtime.playback_notes == [len(b'\xaa\xbb\xcc') / 2 / 24000]


class TestErrorResponse:
    def test_sends_error_notification_on_api_client_error(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.error = RealtimeError('boom')
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        error_packet = mcu.expect_packet()
        assert error_packet.cmd == Command.ERROR
        assert error_packet.body == b''
        mcu.expect_no_packet()

    def test_sends_error_and_resets_session_when_normal_reply_has_no_audio(self, tmp_path: Path) -> None:
        # 感謝インテントなしで応答音声が空（申し送り13の実観測挙動）なら、
        # 空の0x03ではなく0x04を送り、セッションを破棄する。
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'', thanks_detected=False, transcript='(no audio)')
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        error_packet = mcu.expect_packet()
        assert error_packet.cmd == Command.ERROR
        assert error_packet.body == b''
        assert realtime.cancel_calls == 1
        mcu.expect_no_packet()

    def test_thanks_reply_with_empty_model_audio_still_plays_canned_audio(self, tmp_path: Path) -> None:
        # 感謝ターンはモデル音声が空でも定型応答を再生する（既存設計の回帰確認）。
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'', thanks_detected=True, transcript='ありがとう')
        canned_audio = make_canned_audio(tmp_path, pcm=b'\xaa\xbb')
        mcu.send_recorded_audio(b'RECORDED_PCM')

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        play = mcu.expect_packet()
        assert play.cmd == Command.PLAY_AUDIO
        assert play.body == build_play_body(EffectId.THANKS, b'\xaa\xbb')

    def test_sends_error_and_resets_session_when_play_body_build_fails(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript=None)
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        def fail_build_play_body(effect_id: int, pcm: bytes) -> bytes:
            raise ValueError(f'invalid play body: effect={effect_id}, size={len(pcm)}')

        monkeypatch.setattr('pipeline.build_play_body', fail_build_play_body)

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        error_packet = mcu.expect_packet()
        assert error_packet.cmd == Command.ERROR
        assert error_packet.body == b''
        assert realtime.cancel_calls == 1
        mcu.expect_no_packet()


class TestCancelDuringProcessing:
    def test_cancel_discards_result_and_sends_no_play_audio(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.release_event = asyncio.Event()  # 解放されないためrespond_to_audioは待ち続ける
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        async def scenario() -> None:
            task = asyncio.create_task(process_one_event(mcu.pc_transport, realtime, canned_audio, cancel_poll_interval=FAST_CANCEL_POLL_SEC))
            await asyncio.sleep(0.05)  # ACCEPT_PROCESSING送信・処理開始を待つ
            mcu.send_cancel()
            await task

        asyncio.run(scenario())

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        mcu.expect_no_packet()
        assert realtime.cancel_calls == 1
        assert realtime.cancelled_during_wait is True


class TestCancelWhileIdle:
    def test_cancel_while_idle_calls_realtime_cancel(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_cancel()

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert realtime.cancel_calls == 1
        mcu.expect_no_packet()


class TestIdleTimeoutCheck:
    def test_checks_idle_timeout_when_no_packet_arrives(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        canned_audio = make_canned_audio(tmp_path)

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert realtime.idle_check_calls == 1


class TestFirmwareDiagnostic:
    def test_logs_decoded_firmware_diag_while_idle(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        # 0x7F（FW診断）は理由コード・詳細値を解読した警告ログになる（読み捨て警告にならない）。
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        canned_audio = make_canned_audio(tmp_path)
        mcu._mcu_transport.send_packet(0x7F, bytes([0x06]) + (0).to_bytes(4, 'little'))

        with caplog.at_level(logging.WARNING, logger='pipeline'):
            asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert 'Firmware diagnostic: reason=0x06' in caplog.text
        assert 'timed out after 3s' in caplog.text
        assert 'Discarding unexpected packet' not in caplog.text

    def test_logs_raw_body_when_diag_body_is_malformed(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        # BODYが5バイトでない診断パケットも落とさず生バイトをログする。
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        canned_audio = make_canned_audio(tmp_path)
        mcu._mcu_transport.send_packet(0x7F, b'\x01\x02')

        with caplog.at_level(logging.WARNING, logger='pipeline'):
            asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert 'unexpected body: 0102' in caplog.text


class TestUnexpectedPacket:
    def test_discards_unexpected_packet_with_warning(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_ready()

        with caplog.at_level(logging.WARNING):
            asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert any('Discarding unexpected packet' in record.message for record in caplog.records)
        assert realtime.respond_calls == []
        assert realtime.cancel_calls == 0


class TestCorruptedBytes:
    def test_recovers_from_garbage_prefix_before_valid_packet(self, tmp_path: Path) -> None:
        q_mcu_to_pc: queue.Queue[bytes] = queue.Queue()
        q_pc_to_mcu: queue.Queue[bytes] = queue.Queue()
        pc_transport = MemoryTransport(send_queue=q_pc_to_mcu, recv_queue=q_mcu_to_pc)
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript=None)
        canned_audio = make_canned_audio(tmp_path)

        garbage = b'\x00\xff\xa5\x00garbage-bytes'
        q_mcu_to_pc.put(garbage + encode_packet(Command.RECORDED_AUDIO, b'RECORDED_PCM'))

        asyncio.run(process_one_event(pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert realtime.respond_calls == [b'RECORDED_PCM']
        sent = q_pc_to_mcu.get_nowait()
        assert sent == encode_packet(Command.ACCEPT_PROCESSING)

    def test_recovers_from_packet_split_across_multiple_chunks(self, tmp_path: Path) -> None:
        q_mcu_to_pc: queue.Queue[bytes] = queue.Queue()
        q_pc_to_mcu: queue.Queue[bytes] = queue.Queue()
        pc_transport = MemoryTransport(send_queue=q_pc_to_mcu, recv_queue=q_mcu_to_pc)
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript=None)
        canned_audio = make_canned_audio(tmp_path)

        data = encode_packet(Command.RECORDED_AUDIO, b'RECORDED_PCM')
        for i in range(len(data)):
            q_mcu_to_pc.put(data[i : i + 1])

        asyncio.run(process_one_event(pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert realtime.respond_calls == [b'RECORDED_PCM']


class TestRunPipeline:
    def test_processes_pending_recording_before_entering_receive_wait(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript=None)
        canned_audio = make_canned_audio(tmp_path)
        pending = Packet(cmd=Command.RECORDED_AUDIO, body=b'PENDING_PCM')

        async def scenario() -> None:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(
                    run_pipeline(
                        mcu.pc_transport,
                        realtime,
                        canned_audio,
                        pending_recording=pending,
                        idle_poll_interval=FAST_IDLE_POLL_SEC,
                        cancel_poll_interval=FAST_CANCEL_POLL_SEC,
                    ),
                    timeout=0.2,
                )

        asyncio.run(scenario())

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        play = mcu.expect_packet()
        assert play.cmd == Command.PLAY_AUDIO
        assert play.body == build_play_body(EffectId.NORMAL, b'REPLY_PCM')
        assert realtime.respond_calls == [b'PENDING_PCM']


class TestDebugRecordingSave:
    def test_saves_received_recording_when_directory_given(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript=None)
        canned_audio = make_canned_audio(tmp_path)
        debug_dir = tmp_path / 'debug_recordings'
        mcu.send_recorded_audio(b'RECORDED_PCM')

        asyncio.run(
            process_one_event(
                mcu.pc_transport,
                realtime,
                canned_audio,
                idle_poll_interval=FAST_IDLE_POLL_SEC,
                debug_recordings_dir=debug_dir,
            )
        )

        saved_files = list(debug_dir.glob('*.wav'))
        assert len(saved_files) == 1

    def test_does_not_save_when_directory_not_given(self, tmp_path: Path) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript=None)
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert not (tmp_path / 'debug_recordings').exists()

    def test_save_failure_does_not_stop_realtime_processing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript=None)
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        def fail_save_debug_recording(pcm_data: bytes, directory: Path) -> Path:
            raise OSError(f'cannot save {len(pcm_data)} bytes to {directory}')

        monkeypatch.setattr('pipeline.save_debug_recording', fail_save_debug_recording)

        asyncio.run(
            process_one_event(
                mcu.pc_transport,
                realtime,
                canned_audio,
                idle_poll_interval=FAST_IDLE_POLL_SEC,
                debug_recordings_dir=tmp_path / 'debug_recordings',
            )
        )

        assert mcu.expect_packet().cmd == Command.ACCEPT_PROCESSING
        play = mcu.expect_packet()
        assert play.cmd == Command.PLAY_AUDIO
        assert play.body == build_play_body(EffectId.NORMAL, b'REPLY_PCM')
        assert realtime.respond_calls == [b'RECORDED_PCM']
        mcu.expect_no_packet()


class TestResponseSummaryLogging:
    def test_logs_transcript_and_duration_on_success(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.reply = RealtimeReply(audio_pcm=b'REPLY_PCM', thanks_detected=False, transcript='hello there')
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        with caplog.at_level(logging.INFO):
            asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert any("transcript='hello there'" in record.message for record in caplog.records)

    def test_does_not_log_summary_when_api_call_fails(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        mcu = FakeMicrocontroller()
        realtime = FakeRealtimeClient()
        realtime.error = RealtimeError('boom')
        canned_audio = make_canned_audio(tmp_path)
        mcu.send_recorded_audio(b'RECORDED_PCM')

        with caplog.at_level(logging.INFO):
            asyncio.run(process_one_event(mcu.pc_transport, realtime, canned_audio, idle_poll_interval=FAST_IDLE_POLL_SEC))

        assert not any('Realtime response:' in record.message for record in caplog.records)
