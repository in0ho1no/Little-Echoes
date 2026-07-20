"""main のテスト。

実機・実APIには接続せず、`_run()`の配線（設定検証→ポート決定→オープン→
ハンドシェイク→パイプライン起動→close）が正しい順序・引数で行われることを、
モジュール内の各依存をmonkeypatchしたフェイクで確認する。
pytest-asyncioは未導入のため、非同期テストは asyncio.run() で直接駆動する。
"""

import argparse
import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import main as main_module
from device.handshake import HandshakeResult
from device.port_discovery import NoPortAvailableError
from transport.packet import Command, Packet


class FakeTransport:
    """close()呼び出しの有無だけを記録するテスト用フェイク。"""

    def __init__(self) -> None:
        """close()呼び出しの有無を追跡する状態を初期化する。"""
        self.closed = False

    def send_packet(self, cmd: int, body: bytes = b'') -> None:
        raise AssertionError('send_packet should not be called in this test')

    def recv_packet(self, timeout: float | None = None) -> Packet | None:
        raise AssertionError('recv_packet should not be called in this test')

    def close(self) -> None:
        self.closed = True


class FakeRealtimeClient:
    """cancel()呼び出しと失敗を模擬するテスト用フェイク。"""

    def __init__(self, *, cancel_error: Exception | None = None) -> None:
        """終了処理の呼び出し状態と、任意の送出例外を初期化する。"""
        self.cancel_calls = 0
        self.cancel_error = cancel_error

    async def cancel(self) -> None:
        await asyncio.sleep(0)  # 実装同様、後始末が実際に一時中断点を挟むことを模擬する
        self.cancel_calls += 1
        if self.cancel_error is not None:
            raise self.cancel_error


def _patch_common_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    fake_transport: FakeTransport,
    *,
    ready_received: bool = True,
    pending_recording: Packet | None = None,
) -> dict[str, Any]:
    calls: dict[str, Any] = {}

    monkeypatch.setattr(main_module, 'CannedAudio', lambda path: ('canned-audio', path))
    fake_realtime_client = FakeRealtimeClient()
    calls['realtime_client'] = fake_realtime_client

    def fake_realtime_client_factory(**kwargs: Any) -> FakeRealtimeClient:
        calls['realtime_client_kwargs'] = kwargs
        return fake_realtime_client

    monkeypatch.setattr(main_module, 'RealtimeClient', fake_realtime_client_factory)

    def fake_open_serial_transport(port: str) -> FakeTransport:
        calls['opened_port'] = port
        return fake_transport

    monkeypatch.setattr(main_module, 'open_serial_transport', fake_open_serial_transport)

    def fake_wait_for_ready(transport: Any) -> HandshakeResult:
        calls['handshake_transport'] = transport
        return HandshakeResult(ready_received=ready_received, pending_recording=pending_recording)

    monkeypatch.setattr(main_module, 'wait_for_ready', fake_wait_for_ready)

    async def fake_run_pipeline(transport: Any, realtime_client: Any, canned_audio: Any, **kwargs: Any) -> None:
        calls['run_pipeline_args'] = (transport, realtime_client, canned_audio, kwargs)

    monkeypatch.setattr(main_module, 'run_pipeline', fake_run_pipeline)

    return calls


class TestBuildArgParser:
    def test_defaults(self) -> None:
        args = main_module._build_arg_parser().parse_args([])

        assert args.port is None
        assert args.canned_audio == main_module.DEFAULT_CANNED_AUDIO_PATH
        assert args.debug_recordings_dir is None
        assert args.model == main_module.MODEL_NAME

    def test_overrides(self) -> None:
        args = main_module._build_arg_parser().parse_args(
            ['--port', 'COM5', '--canned-audio', 'x.pcm', '--debug-recordings-dir', 'dbg', '--model', 'gpt-realtime-2.1-mini']
        )

        assert args.port == 'COM5'
        assert args.canned_audio == Path('x.pcm')
        assert args.debug_recordings_dir == Path('dbg')
        assert args.model == 'gpt-realtime-2.1-mini'


class TestRun:
    def test_auto_detects_port_and_wires_dependencies_in_order(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario() -> None:
            fake_transport = FakeTransport()
            monkeypatch.setattr(main_module, 'select_port', lambda: SimpleNamespace(device='COM7'))
            calls = _patch_common_dependencies(monkeypatch, fake_transport)

            args = main_module._build_arg_parser().parse_args([])
            await main_module._run(args)

            assert calls['opened_port'] == 'COM7'
            assert calls['handshake_transport'] is fake_transport
            transport, realtime_client, canned_audio, kwargs = calls['run_pipeline_args']
            assert transport is fake_transport
            assert realtime_client is calls['realtime_client']
            assert canned_audio == ('canned-audio', main_module.DEFAULT_CANNED_AUDIO_PATH)
            assert kwargs['pending_recording'] is None
            assert kwargs['debug_recordings_dir'] is None
            assert calls['realtime_client_kwargs'] == {'model': main_module.MODEL_NAME}
            assert calls['realtime_client'].cancel_calls == 1
            assert fake_transport.closed is True

        asyncio.run(scenario())

    def test_passes_model_override_to_realtime_client(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario() -> None:
            fake_transport = FakeTransport()
            calls = _patch_common_dependencies(monkeypatch, fake_transport)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM1', '--model', 'gpt-realtime-2.1-mini'])
            await main_module._run(args)

            assert calls['realtime_client_kwargs'] == {'model': 'gpt-realtime-2.1-mini'}

        asyncio.run(scenario())

    def test_explicit_port_skips_auto_detection(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario() -> None:
            fake_transport = FakeTransport()

            def fail_select_port() -> Any:
                raise AssertionError('select_port should not be called when --port is given')

            monkeypatch.setattr(main_module, 'select_port', fail_select_port)
            calls = _patch_common_dependencies(monkeypatch, fake_transport)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM9'])
            await main_module._run(args)

            assert calls['opened_port'] == 'COM9'

        asyncio.run(scenario())

    def test_passes_pending_recording_from_handshake(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario() -> None:
            fake_transport = FakeTransport()
            pending = Packet(cmd=Command.RECORDED_AUDIO, body=b'pcm')
            calls = _patch_common_dependencies(monkeypatch, fake_transport, ready_received=False, pending_recording=pending)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM1'])
            await main_module._run(args)

            _, _, _, kwargs = calls['run_pipeline_args']
            assert kwargs['pending_recording'] is pending

        asyncio.run(scenario())

    def test_passes_debug_recordings_dir_through(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario() -> None:
            fake_transport = FakeTransport()
            calls = _patch_common_dependencies(monkeypatch, fake_transport)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM1', '--debug-recordings-dir', 'dbg'])
            await main_module._run(args)

            _, _, _, kwargs = calls['run_pipeline_args']
            assert kwargs['debug_recordings_dir'] == Path('dbg')

        asyncio.run(scenario())

    def test_closes_transport_even_if_pipeline_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario() -> None:
            fake_transport = FakeTransport()
            fake_realtime_client = FakeRealtimeClient()
            monkeypatch.setattr(main_module, 'CannedAudio', lambda path: 'canned-audio')
            monkeypatch.setattr(main_module, 'RealtimeClient', lambda **kwargs: fake_realtime_client)
            monkeypatch.setattr(main_module, 'open_serial_transport', lambda port: fake_transport)
            monkeypatch.setattr(main_module, 'wait_for_ready', lambda transport: HandshakeResult(ready_received=True, pending_recording=None))

            async def failing_run_pipeline(*args: Any, **kwargs: Any) -> None:
                raise RuntimeError('boom')

            monkeypatch.setattr(main_module, 'run_pipeline', failing_run_pipeline)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM1'])
            with pytest.raises(RuntimeError, match='boom'):
                await main_module._run(args)

            assert fake_realtime_client.cancel_calls == 1
            assert fake_transport.closed is True

        asyncio.run(scenario())

    def test_closes_transport_and_cancels_realtime_client_when_pipeline_is_cancelled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """run_pipeline側がCancelledErrorで終了する経路（Ctrl+C等）でもfinallyが完走することを確認する。"""

        async def scenario() -> None:
            fake_transport = FakeTransport()
            fake_realtime_client = FakeRealtimeClient()
            monkeypatch.setattr(main_module, 'CannedAudio', lambda path: 'canned-audio')
            monkeypatch.setattr(main_module, 'RealtimeClient', lambda **kwargs: fake_realtime_client)
            monkeypatch.setattr(main_module, 'open_serial_transport', lambda port: fake_transport)
            monkeypatch.setattr(main_module, 'wait_for_ready', lambda transport: HandshakeResult(ready_received=True, pending_recording=None))

            async def cancelled_run_pipeline(*args: Any, **kwargs: Any) -> None:
                raise asyncio.CancelledError

            monkeypatch.setattr(main_module, 'run_pipeline', cancelled_run_pipeline)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM1'])
            with pytest.raises(asyncio.CancelledError):
                await main_module._run(args)

            assert fake_realtime_client.cancel_calls == 1
            assert fake_transport.closed is True

        asyncio.run(scenario())

    def test_closes_transport_even_if_realtime_cleanup_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario() -> None:
            fake_transport = FakeTransport()
            fake_realtime_client = FakeRealtimeClient(cancel_error=RuntimeError('cleanup failed'))
            monkeypatch.setattr(main_module, 'CannedAudio', lambda path: 'canned-audio')
            monkeypatch.setattr(main_module, 'RealtimeClient', lambda **kwargs: fake_realtime_client)
            monkeypatch.setattr(main_module, 'open_serial_transport', lambda port: fake_transport)
            monkeypatch.setattr(main_module, 'wait_for_ready', lambda transport: HandshakeResult(ready_received=True, pending_recording=None))

            async def fake_run_pipeline(*args: Any, **kwargs: Any) -> None:
                pass

            monkeypatch.setattr(main_module, 'run_pipeline', fake_run_pipeline)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM1'])
            with pytest.raises(RuntimeError, match='cleanup failed'):
                await main_module._run(args)

            assert fake_realtime_client.cancel_calls == 1
            assert fake_transport.closed is True

        asyncio.run(scenario())

    def test_validates_config_before_opening_port(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """定型応答PCM未生成等の設定不備は、ポートを開く前に検出できることを確認する。"""

        async def scenario() -> None:
            def failing_canned_audio(path: Path) -> None:
                raise FileNotFoundError(f'{path} not found')

            monkeypatch.setattr(main_module, 'CannedAudio', failing_canned_audio)

            def fail_open_serial_transport(port: str) -> FakeTransport:
                raise AssertionError('port should not be opened when config validation fails')

            monkeypatch.setattr(main_module, 'open_serial_transport', fail_open_serial_transport)

            args = main_module._build_arg_parser().parse_args(['--port', 'COM1'])
            with pytest.raises(FileNotFoundError):
                await main_module._run(args)

        asyncio.run(scenario())


class TestMainErrorHandling:
    def test_reports_friendly_error_and_exits_nonzero_on_no_port_available(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        monkeypatch.setattr('sys.argv', ['main.py'])

        async def failing_run(args: argparse.Namespace) -> None:
            raise NoPortAvailableError('no ports found')

        monkeypatch.setattr(main_module, '_run', failing_run)

        with pytest.raises(SystemExit) as exc_info:
            main_module.main()

        assert exc_info.value.code == 1
        assert 'no ports found' in capsys.readouterr().err

    def test_keyboard_interrupt_exits_cleanly(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr('sys.argv', ['main.py'])

        async def interrupting_run(args: argparse.Namespace) -> None:
            raise KeyboardInterrupt

        monkeypatch.setattr(main_module, '_run', interrupting_run)

        main_module.main()  # 例外を送出せず正常終了することを確認
