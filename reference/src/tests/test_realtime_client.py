"""openai_client.realtime_client のテスト。

pytest-asyncioは未導入のため、非同期テストは asyncio.run() で直接駆動する。
接続オブジェクトはフェイク（FakeConnection等）をDIし、実際のWebSocket接続は張らない。
"""

import asyncio
import base64
from types import SimpleNamespace
from typing import Any

import pytest

from openai_client.errors import ApiClientError
from openai_client.realtime_client import THANKS_TOOL_NAME, RealtimeClient, RealtimeError

_CLOSE_SENTINEL = object()


def audio_delta_event(pcm: bytes) -> SimpleNamespace:
    return SimpleNamespace(type='response.output_audio.delta', delta=base64.b64encode(pcm).decode('ascii'))


def transcript_done_event(transcript: str) -> SimpleNamespace:
    return SimpleNamespace(type='response.output_audio_transcript.done', transcript=transcript)


def response_done_event(status: str = 'completed', output: list[Any] | None = None, usage: SimpleNamespace | None = None) -> SimpleNamespace:
    return SimpleNamespace(type='response.done', response=SimpleNamespace(status=status, output=output or [], usage=usage))


def function_call_item(name: str) -> SimpleNamespace:
    return SimpleNamespace(type='function_call', name=name)


def error_event(message: str) -> SimpleNamespace:
    return SimpleNamespace(type='error', error=SimpleNamespace(message=message))


class FakeSessionResource:
    def __init__(self) -> None:
        """session.update()の呼び出し内容を記録するだけのフェイク。"""
        self.updates: list[dict[str, Any]] = []

    async def update(self, *, session: dict[str, Any]) -> None:
        self.updates.append(session)


class FakeInputAudioBufferResource:
    def __init__(self) -> None:
        """clear/append/commitの呼び出し回数・内容を記録するフェイク。"""
        self.clear_calls = 0
        self.appended: list[bytes] = []
        self.commit_calls = 0
        self.fail_on_commit = False

    async def clear(self) -> None:
        self.clear_calls += 1

    async def append(self, *, audio: str) -> None:
        self.appended.append(base64.b64decode(audio))

    async def commit(self) -> None:
        if self.fail_on_commit:
            raise ConnectionError('fake commit failure')
        self.commit_calls += 1


class FakeResponseResource:
    def __init__(self) -> None:
        """create/cancelの呼び出し回数を記録するフェイク。"""
        self.create_calls = 0
        self.cancel_calls = 0

    async def create(self) -> None:
        self.create_calls += 1

    async def cancel(self) -> None:
        self.cancel_calls += 1


class FakeConnection:
    def __init__(self) -> None:
        """RealtimeConnection相当のフェイク。イベントはキュー経由で注入する。"""
        self.session = FakeSessionResource()
        self.input_audio_buffer = FakeInputAudioBufferResource()
        self.response = FakeResponseResource()
        self.queue: asyncio.Queue[Any] = asyncio.Queue()
        self.closed = False

    def queue_events(self, events: list[Any]) -> None:
        for event in events:
            self.queue.put_nowait(event)

    async def __aiter__(self) -> Any:
        """キューに積んだイベントを順に返す。`_CLOSE_SENTINEL`で列挙を終了する。"""
        while True:
            event = await self.queue.get()
            if event is _CLOSE_SENTINEL:
                return
            yield event

    async def close(self) -> None:
        self.closed = True
        self.queue.put_nowait(_CLOSE_SENTINEL)


class FakeConnectionManager:
    def __init__(self, factory: 'FakeConnectionFactory') -> None:
        """`client.realtime.connect()`相当のフェイク。`enter()`でFakeConnectionを返す。"""
        self._factory = factory

    async def enter(self) -> FakeConnection:
        self._factory.connect_count += 1
        if self._factory.fail_next_connects > 0:
            self._factory.fail_next_connects -= 1
            raise ConnectionError('fake connect failure')
        connection = FakeConnection()
        if self._factory.fail_next_commit:
            connection.input_audio_buffer.fail_on_commit = True
            self._factory.fail_next_commit = False
        self._factory.connections.append(connection)
        return connection


class FakeConnectionFactory:
    def __init__(self) -> None:
        """connection_factoryにDIするフェイク。接続失敗・送信失敗の注入フラグを持つ。"""
        self.connections: list[FakeConnection] = []
        self.connect_count = 0
        self.fail_next_connects = 0
        self.fail_next_commit = False

    def __call__(self) -> FakeConnectionManager:
        return FakeConnectionManager(self)


async def _start_turn(client: RealtimeClient, factory: FakeConnectionFactory, pcm: bytes) -> tuple[asyncio.Future[Any], FakeConnection]:
    """respond_to_audio()を開始し、コネクション生成後・イベント待ち直前まで進めてから返す。"""
    task = asyncio.ensure_future(client.respond_to_audio(pcm))
    await asyncio.sleep(0)
    return task, factory.connections[-1]


class TestSessionSetup:
    def test_realtime_error_is_api_client_error(self) -> None:
        assert issubclass(RealtimeError, ApiClientError)

    def test_missing_api_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv('OPENAI_API_KEY_VIG', raising=False)

        with pytest.raises(RealtimeError):
            RealtimeClient()


class TestRespondToAudio:
    def test_returns_audio_and_transcript_on_success(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory)

            task, connection = await _start_turn(client, factory, b'input-pcm')
            connection.queue_events(
                [
                    audio_delta_event(b'AAAA'),
                    audio_delta_event(b'BBBB'),
                    transcript_done_event('こんにちは'),
                    response_done_event(status='completed'),
                ]
            )
            reply = await task

            assert reply.audio_pcm == b'AAAABBBB'
            assert reply.transcript == 'こんにちは'
            assert reply.thanks_detected is False
            assert connection.input_audio_buffer.appended == [b'input-pcm']
            session = connection.session.updates[0]
            assert session['audio']['input']['turn_detection'] is None
            assert session['audio']['input']['format'] == {'type': 'audio/pcm', 'rate': 24000}

        asyncio.run(scenario())

    def test_instructions_override_is_sent_in_session_config(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, instructions='できるだけ長く話してください。')

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([response_done_event()])
            await task

            assert connection.session.updates[0]['instructions'] == 'できるだけ長く話してください。'

        asyncio.run(scenario())

    def test_detects_thanks_tool_call(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([response_done_event(status='completed', output=[function_call_item(THANKS_TOOL_NAME)])])
            reply = await task

            assert reply.thanks_detected is True

        asyncio.run(scenario())

    def test_extracts_usage_when_present(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory)

            task, connection = await _start_turn(client, factory, b'pcm')
            usage = SimpleNamespace(input_tokens=12, output_tokens=34, total_tokens=46)
            connection.queue_events([response_done_event(status='completed', usage=usage)])
            reply = await task

            assert reply.usage == {'input_tokens': 12, 'output_tokens': 34, 'total_tokens': 46}

        asyncio.run(scenario())

    def test_usage_is_none_when_not_provided(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([response_done_event(status='completed')])
            reply = await task

            assert reply.usage is None

        asyncio.run(scenario())

    def test_truncates_audio_at_byte_cap_and_cancels(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, max_response_audio_bytes=10)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events(
                [
                    audio_delta_event(b'0123456789'),
                    audio_delta_event(b'EXTRA'),
                    response_done_event(status='cancelled'),
                ]
            )
            reply = await task

            assert reply.audio_pcm == b'0123456789'
            assert connection.response.cancel_calls == 1

        asyncio.run(scenario())

    def test_does_not_cancel_audio_exactly_at_byte_cap(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, max_response_audio_bytes=10)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([audio_delta_event(b'0123456789'), response_done_event(status='completed')])
            reply = await task

            assert reply.audio_pcm == b'0123456789'
            assert connection.response.cancel_calls == 0

        asyncio.run(scenario())

    def test_clears_input_buffer_at_each_turn(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, max_round_trips=3)

            for pcm in (b'turn0', b'turn1'):
                task, connection = await _start_turn(client, factory, pcm)
                connection.queue_events([response_done_event()])
                await task

            assert factory.connect_count == 1
            buf = factory.connections[0].input_audio_buffer
            assert buf.clear_calls == 2
            assert buf.commit_calls == 2
            assert buf.appended == [b'turn0', b'turn1']

        asyncio.run(scenario())


class TestSessionLifecycle:
    def test_disposes_session_after_max_round_trips_then_starts_new_one(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, max_round_trips=3)

            for i in range(3):
                task, connection = await _start_turn(client, factory, f'turn{i}'.encode())
                connection.queue_events([response_done_event()])
                await task

            assert factory.connect_count == 1
            assert factory.connections[0].closed is True

            task, connection2 = await _start_turn(client, factory, b'turn3')
            connection2.queue_events([response_done_event()])
            await task

            assert factory.connect_count == 2

        asyncio.run(scenario())

    def test_check_idle_timeout_disposes_session_after_elapsed(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, idle_timeout_sec=0.05)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([response_done_event()])
            await task

            assert await client.check_idle_timeout() is False
            assert connection.closed is False

            await asyncio.sleep(0.2)

            assert await client.check_idle_timeout() is True
            assert connection.closed is True

        asyncio.run(scenario())

    def test_stale_session_is_disposed_as_fallback_when_idle_poll_is_missed(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, idle_timeout_sec=0.05)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([response_done_event()])
            await task

            await asyncio.sleep(0.2)

            # check_idle_timeout()を挟まず直接次のターンを開始しても、
            # 古いセッションが再利用されず新セッションに切り替わることを確認する（SPEC §7.2-2フォールバック）。
            task2, connection2 = await _start_turn(client, factory, b'pcm2')
            connection2.queue_events([response_done_event()])
            await task2

            assert connection.closed is True
            assert factory.connect_count == 2
            assert connection2 is not connection

        asyncio.run(scenario())

    def test_check_idle_timeout_is_noop_without_session(self) -> None:
        async def scenario() -> None:
            client = RealtimeClient(connection_factory=FakeConnectionFactory())
            assert await client.check_idle_timeout() is False

        asyncio.run(scenario())

    def test_note_playback_duration_defers_idle_timeout(self) -> None:
        # 応答再生中（再生時間ぶん先送りした期限内）はアイドル破棄されず、
        # 再生終了（推定）＋アイドル時間の経過後に破棄される（SPEC §7.2-2 v1.3.3）。
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, idle_timeout_sec=0.05)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([response_done_event()])
            await task

            await client.note_playback_duration(0.3)
            await asyncio.sleep(0.2)  # 旧起点なら期限超過だが、再生中扱いのため生存する

            assert await client.check_idle_timeout() is False
            assert connection.closed is False

            await asyncio.sleep(0.3)  # 再生終了(+0.3s)からさらにアイドル時間(0.05s)超過

            assert await client.check_idle_timeout() is True
            assert connection.closed is True

        asyncio.run(scenario())

    def test_note_playback_duration_is_noop_without_session(self) -> None:
        # 3往復完了直後などセッション破棄済みの状態で呼ばれても何も起きない。
        async def scenario() -> None:
            client = RealtimeClient(connection_factory=FakeConnectionFactory())
            await client.note_playback_duration(10.0)
            assert await client.check_idle_timeout() is False

        asyncio.run(scenario())

    def test_cancel_disposes_in_progress_session(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory)

            task, connection = await _start_turn(client, factory, b'pcm')
            await client.cancel()

            assert connection.response.cancel_calls == 1
            assert connection.closed is True
            with pytest.raises(asyncio.CancelledError):
                await task
            assert factory.connect_count == 1

        asyncio.run(scenario())

    def test_cancel_without_session_is_noop(self) -> None:
        async def scenario() -> None:
            client = RealtimeClient(connection_factory=FakeConnectionFactory())
            await client.cancel()  # 例外を送出しないことのみ確認

        asyncio.run(scenario())


class TestErrorHandling:
    def test_api_error_raises_and_disposes_session_without_retry(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory)

            task, connection = await _start_turn(client, factory, b'pcm')
            connection.queue_events([error_event('APIエラー発生')])

            with pytest.raises(RealtimeError):
                await task

            assert connection.closed is True
            assert factory.connect_count == 1

        asyncio.run(scenario())

    def test_response_timeout_raises_and_disposes_session(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            client = RealtimeClient(connection_factory=factory, response_timeout_sec=0.05)

            with pytest.raises(RealtimeError):
                await client.respond_to_audio(b'pcm')

            assert factory.connect_count == 1
            assert factory.connections[0].closed is True

        asyncio.run(scenario())

    def test_connection_failure_retries_once_and_succeeds_on_new_session(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            factory.fail_next_commit = True
            client = RealtimeClient(connection_factory=factory)

            task = asyncio.ensure_future(client.respond_to_audio(b'pcm'))
            await asyncio.sleep(0)

            assert factory.connect_count == 2
            assert factory.connections[0].closed is True
            retry_connection = factory.connections[1]
            retry_connection.queue_events([response_done_event()])

            reply = await task

            assert reply.audio_pcm == b''
            assert retry_connection.input_audio_buffer.appended == [b'pcm']

        asyncio.run(scenario())

    def test_connection_failure_retry_also_fails_raises_realtime_error(self) -> None:
        async def scenario() -> None:
            factory = FakeConnectionFactory()
            factory.fail_next_connects = 2
            client = RealtimeClient(connection_factory=factory)

            with pytest.raises(RealtimeError):
                await client.respond_to_audio(b'pcm')

            assert factory.connect_count == 2
            assert factory.connections == []

        asyncio.run(scenario())
