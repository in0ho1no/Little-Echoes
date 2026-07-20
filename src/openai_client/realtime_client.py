"""OpenAI Realtime API（speech-to-speech）クライアント。docs/SPEC.md §7.2 参照。

会話サイクルは「1セッション＝1サイクル（最大3往復）」で管理する（docs/task.md 申し送り11）。
セッションは `respond_to_audio()` の初回呼び出し時に遅延確立し、以下のいずれかで破棄する。

- 成功往復が `max_round_trips` 回に達したとき
- `check_idle_timeout()` が最終応答完了からのアイドル時間超過を検知したとき
- `cancel()` が呼ばれたとき
- Realtime APIがエラーを返したとき（`RealtimeError` を送出）
- 接続断・送信失敗を検知したとき（アプリ側制御で新セッションにより1回だけ再試行し、
  再試行も失敗したら `RealtimeError` を送出）

SDKの自動再接続・自動再試行は使わない（`connect()` にreconnectハンドラを渡さないことで無効化される）。
テストでは `connection_factory` にフェイクを注入し、実際のWebSocket接続を張らずに検証する。
"""

import asyncio
import base64
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

from openai_client.errors import ApiClientError

logger = logging.getLogger(__name__)

API_KEY_ENV_VAR = 'OPENAI_API_KEY_VIG'
MODEL_NAME = 'gpt-realtime-mini'

# マイコン側§3.5のタイムアウト(35秒)より10秒短くし、BODY組み立てとシリアル送信の余裕を確保する。
# 初回呼び出しと接続断時の1回の再試行を合わせた共通期限（docs/task.md 申し送り9）。
RESPONSE_TIMEOUT_SEC = 25.0

# 最終応答完了からこの秒数だけ次の発話がなければセッションを破棄する（docs/SPEC.md §7.2-2）。
IDLE_TIMEOUT_SEC = 15.0

# 会話サイクルあたりの最大往復数。到達したら履歴を一括リセットするためセッションを破棄する。
MAX_ROUND_TRIPS = 3

# 24kHz/16bit/モノラルで30秒 = 24000 * 2 * 30。docs/SPEC.md §4.2の最大応答長。
MAX_RESPONSE_AUDIO_BYTES = 1_440_000

# 感謝インテント通知用のfunction calling名（旧JSONモード構造化出力の代替）。
THANKS_TOOL_NAME = 'notify_thanks_intent'

_INSTRUCTIONS = (
    '応答は短い話し言葉で、一文か二文程度の簡潔な日本語で返答してください。'
    f'ユーザーが感謝の言葉（「ありがとう」等）を述べた場合は、返答の生成とあわせて {THANKS_TOOL_NAME} 関数を呼び出してください。'
)

# connection_factory()の戻り値は、`await manager.enter()` でconnectionを返すオブジェクト
# （実体は openai.AsyncOpenAI().realtime.connect(model=...) の戻り値と同じ形）を期待する。
# connectionは session / input_audio_buffer / response の各リソースと、
# `async for event in connection:` によるサーバイベント列挙、`await connection.close()` を持つ。
# 実際のSDK型は複雑なため、DIしたフェイクとの両立を優先しAnyで扱う。
ConnectionFactory = Callable[[], Any]


@dataclass(frozen=True)
class RealtimeReply:
    """1往復分のRealtime API応答。"""

    audio_pcm: bytes
    thanks_detected: bool
    transcript: str | None
    usage: dict[str, int] | None = None
    """レスポンスのusage情報（取得できる場合のみ。docs/SPEC.md 「デバッグ・運用補助」参照）。"""


class RealtimeError(ApiClientError):
    """Realtime APIの呼び出し失敗（APIエラー・タイムアウト・接続断の再試行失敗）を表す。"""


class _ConnectionFailureError(Exception):
    """内部用: WebSocket接続の確立・送受信の失敗を示すマーカー。1回だけ再試行される。"""


def _extract_usage(response: Any) -> dict[str, int] | None:
    """`response.done`イベントのresponseからusage情報を抽出する。

    SDKのusageオブジェクトの正確な型・提供有無に依存しないよう、`getattr`で
    存在するフィールドのみを拾う（docs/SPEC.md「デバッグ・運用補助」の
    「usage（取得できる場合）」に対応）。

    Returns:
        取得できたusageフィールドのdict。usage自体が存在しない、またはどの
        フィールドも取得できなかった場合はNone。
    """
    usage = getattr(response, 'usage', None)
    if usage is None:
        return None
    result: dict[str, int] = {}
    for key in ('input_tokens', 'output_tokens', 'total_tokens'):
        value = getattr(usage, key, None)
        if value is not None:
            result[key] = value
    return result or None


def _build_session_config(instructions: str | None = None) -> dict[str, Any]:
    return {
        'type': 'realtime',
        'output_modalities': ['audio'],
        'instructions': instructions if instructions is not None else _INSTRUCTIONS,
        'audio': {
            'input': {
                'format': {'type': 'audio/pcm', 'rate': 24000},
                'turn_detection': None,
            },
            'output': {
                'format': {'type': 'audio/pcm', 'rate': 24000},
            },
        },
        'tools': [
            {
                'type': 'function',
                'name': THANKS_TOOL_NAME,
                'description': 'ユーザーが感謝の言葉（「ありがとう」等）を述べたことをアプリケーションに通知する。',
                'parameters': {'type': 'object', 'properties': {}},
            }
        ],
    }


def _make_default_connection_factory(client: AsyncOpenAI, model: str) -> ConnectionFactory:
    def factory() -> Any:
        return client.realtime.connect(model=model)

    return factory


class RealtimeClient:
    """Realtimeセッションのライフサイクル管理と1往復API `respond_to_audio()` を提供する。"""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str = MODEL_NAME,
        instructions: str | None = None,
        connection_factory: ConnectionFactory | None = None,
        response_timeout_sec: float = RESPONSE_TIMEOUT_SEC,
        idle_timeout_sec: float = IDLE_TIMEOUT_SEC,
        max_round_trips: int = MAX_ROUND_TRIPS,
        max_response_audio_bytes: int = MAX_RESPONSE_AUDIO_BYTES,
    ) -> None:
        """RealtimeClientを初期化する。

        Args:
            api_key: OpenAI APIキー。省略時は環境変数 `OPENAI_API_KEY_VIG` を参照する
                （`connection_factory` を指定した場合は参照しない）。
            model: 使用するRealtimeモデル名。
            instructions: セッションのinstructionsを上書きする。省略時は既定の簡潔応答指示を使う。
                主にタスク12の手動確認スクリプトで、意図的に長い応答を発生させ30秒上限の
                打ち切り挙動を実APIで検証する用途を想定する（docs/task.md 申し送り12）。
            connection_factory: 接続オブジェクトの生成方法。テストでフェイクを注入するためのDIポイント。
                省略時は `AsyncOpenAI` クライアントによる本番接続を使う（SDKの自動再試行は無効化する）。
            response_timeout_sec: 応答待ちタイムアウト（初回と1回の再試行を合わせた共通期限）。
            idle_timeout_sec: 最終応答完了からセッションを破棄するまでのアイドル秒数。
            max_round_trips: 1サイクルあたりの最大往復数。到達時にセッションを破棄する。
            max_response_audio_bytes: 応答音声の上限バイト数。超過分は`response.cancel`で打ち切る。
        """
        self._model = model
        self._response_timeout_sec = response_timeout_sec
        self._idle_timeout_sec = idle_timeout_sec
        self._max_round_trips = max_round_trips
        self._max_response_audio_bytes = max_response_audio_bytes
        self._session_config = _build_session_config(instructions)

        if connection_factory is not None:
            self._connection_factory = connection_factory
        else:
            key = api_key or os.environ.get(API_KEY_ENV_VAR)
            if not key:
                raise RealtimeError(f'{API_KEY_ENV_VAR} environment variable is not set.')
            client = AsyncOpenAI(api_key=key, max_retries=0)
            self._connection_factory = _make_default_connection_factory(client, model)

        self._connection: Any | None = None
        self._round_trip_count = 0
        self._last_response_completed_at: float | None = None
        self._active_turn_task: asyncio.Task[Any] | None = None

    async def respond_to_audio(self, pcm_bytes: bytes) -> RealtimeReply:
        """録音PCM(24kHz/16bit/モノラル)を1往復分Realtime APIへ送り、応答を受け取る。

        セッション未接続なら新規接続する（サイクル開始）。接続断・送信失敗を検知した場合は
        セッションを破棄し、同じ音声で1回だけ新セッションによる再試行を行う
        （タイムアウト・APIエラー時は再試行しない）。

        Args:
            pcm_bytes: 送信する録音PCMデータ。

        Returns:
            応答音声・感謝インテント検出有無・transcriptを含む `RealtimeReply`。

        Raises:
            RealtimeError: APIエラー、応答待ちタイムアウト、または再試行後も
                接続が失敗した場合。
        """
        current_task = asyncio.current_task()
        active_task = self._active_turn_task
        if active_task is not None and not active_task.done():
            raise RealtimeError('A Realtime response is already in progress.')
        self._active_turn_task = current_task

        try:
            deadline = time.monotonic() + self._response_timeout_sec
            try:
                return await self._attempt(pcm_bytes, deadline)
            except _ConnectionFailureError as exc:
                logger.warning('Realtime connection failure (%s); discarding session and retrying once.', exc)
                await self._dispose_session(reason='connection failure')
                try:
                    return await self._attempt(pcm_bytes, deadline)
                except _ConnectionFailureError as retry_exc:
                    await self._dispose_session(reason='connection failure after retry')
                    raise RealtimeError(f'Realtime API connection failed after one retry: {retry_exc}') from retry_exc
                except TimeoutError as retry_exc:
                    await self._dispose_session(reason='timeout after retry')
                    raise RealtimeError('Realtime API response timed out.') from retry_exc
            except TimeoutError as exc:
                await self._dispose_session(reason='timeout')
                raise RealtimeError('Realtime API response timed out.') from exc
        finally:
            if self._active_turn_task is current_task:
                self._active_turn_task = None

    async def note_playback_duration(self, playback_sec: float) -> None:
        """アイドルタイムアウトの起点を「応答再生の終了（推定）」まで先送りする。

        アイドルタイムアウトは「ユーザーが15秒黙ったら別の会話」（docs/SPEC.md §7.2-2）の
        実現だが、応答受信の完了時刻を起点にすると、マイコン側の再生（最大30秒。再生中の
        ボタン押下は受け付けない）が終わる前に期限が来てしまい、長い応答の直後はユーザーが
        応じる間もなくセッションが破棄される（SPEC v1.3.3で起点を改訂）。
        `0x03`送信後に再生時間を渡して呼び出すこと。

        Args:
            playback_sec: 送信した応答音声の再生時間（秒）。
        """
        if self._connection is None or self._last_response_completed_at is None:
            return  # セッション破棄済み（3往復完了直後等）なら先送りする期限もない
        self._last_response_completed_at = time.monotonic() + playback_sec

    async def check_idle_timeout(self) -> bool:
        """アイドル時間が上限を超えていればセッションを破棄する。

        起点は応答再生の終了推定（`note_playback_duration`で先送りされた時刻。SPEC §7.2-2）。
        受信待機ループからポーリング周期ごとに呼ぶことを想定する。

        Returns:
            アイドルタイムアウトによりセッションを破棄した場合はTrue。
        """
        if self._connection is None or self._last_response_completed_at is None:
            return False
        elapsed = time.monotonic() - self._last_response_completed_at
        if elapsed < self._idle_timeout_sec:
            return False
        logger.info('Idle for %.1f seconds; disposing Realtime session.', elapsed)
        await self._dispose_session(reason='idle timeout')
        return True

    async def cancel(self) -> None:
        """進行中の応答を中止し、セッションを破棄する（0x05受信時のサイクル全体破棄）。"""
        active_task = self._active_turn_task
        if active_task is not None and active_task is not asyncio.current_task() and not active_task.done():
            active_task.cancel()
        if self._connection is None:
            return
        try:
            await self._connection.response.cancel()
        except Exception:
            logger.warning('Failed to send response.cancel; disposing session anyway.', exc_info=True)
        await self._dispose_session(reason='cancelled')

    async def _attempt(self, pcm_bytes: bytes, deadline: float) -> RealtimeReply:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Realtime API response timed out.')

        try:
            reply = await asyncio.wait_for(self._run_turn(pcm_bytes), timeout=remaining)
        except RealtimeError:
            raise
        except TimeoutError:
            raise
        except Exception as exc:
            raise _ConnectionFailureError(str(exc)) from exc

        self._round_trip_count += 1
        self._last_response_completed_at = time.monotonic()
        if self._round_trip_count >= self._max_round_trips:
            logger.info('Completed %d round trip(s); disposing Realtime session.', self._round_trip_count)
            await self._dispose_session(reason='max round trips reached')
        return reply

    async def _run_turn(self, pcm_bytes: bytes) -> RealtimeReply:
        connection = await self._ensure_connection()
        # VAD無効時は各ターン先頭でバッファをclearし、前回の未コミット音声の混入を防ぐ（docs/SPEC.md §7.2-5）。
        await connection.input_audio_buffer.clear()
        await connection.input_audio_buffer.append(audio=base64.b64encode(pcm_bytes).decode('ascii'))
        await connection.input_audio_buffer.commit()
        await connection.response.create()
        return await self._collect_response(connection)

    async def _collect_response(self, connection: Any) -> RealtimeReply:
        audio_chunks: list[bytes] = []
        total_bytes = 0
        size_limit_reached = False
        transcript: str | None = None
        thanks_detected = False

        async for event in connection:
            event_type = getattr(event, 'type', None)

            if event_type == 'response.output_audio.delta':
                if not size_limit_reached:
                    chunk = base64.b64decode(event.delta)
                    remaining_capacity = self._max_response_audio_bytes - total_bytes
                    if len(chunk) > remaining_capacity:
                        if remaining_capacity > 0:
                            audio_chunks.append(chunk[:remaining_capacity])
                            total_bytes += remaining_capacity
                        size_limit_reached = True
                        logger.info('Response audio exceeded the %d byte cap; requesting cancellation.', self._max_response_audio_bytes)
                        await connection.response.cancel()
                    else:
                        audio_chunks.append(chunk)
                        total_bytes += len(chunk)

            elif event_type == 'response.output_audio_transcript.done':
                transcript = event.transcript

            elif event_type == 'error':
                message = event.error.message
                await self._dispose_session(reason='api error')
                raise RealtimeError(f'Realtime API returned an error: {message}')

            elif event_type == 'response.done':
                response = event.response
                for item in response.output or []:
                    if getattr(item, 'type', None) == 'function_call' and getattr(item, 'name', None) == THANKS_TOOL_NAME:
                        thanks_detected = True
                if response.status == 'failed':
                    await self._dispose_session(reason='api error')
                    raise RealtimeError(f'Realtime API response failed (status={response.status}).')
                usage = _extract_usage(response)
                return RealtimeReply(audio_pcm=b''.join(audio_chunks), thanks_detected=thanks_detected, transcript=transcript, usage=usage)

        raise _ConnectionFailureError('Realtime connection closed before response.done was received.')

    async def _ensure_connection(self) -> Any:
        if self._connection is not None and self._last_response_completed_at is not None:
            # ポーリングでのcheck_idle_timeout()呼び出しが漏れても、ターン開始時に必ず
            # 経過時間を再確認する（docs/SPEC.md §7.2-2のフォールバック規定）。
            elapsed = time.monotonic() - self._last_response_completed_at
            if elapsed >= self._idle_timeout_sec:
                logger.info('Idle for %.1f seconds at turn start; disposing stale Realtime session as a fallback.', elapsed)
                await self._dispose_session(reason='idle timeout (fallback)')
        if self._connection is not None:
            return self._connection
        manager = self._connection_factory()
        connection = await manager.enter()
        # session.update失敗時もdispose対象にできるよう、確立直後に保持する。
        self._connection = connection
        self._round_trip_count = 0
        await connection.session.update(session=self._session_config)
        logger.info('Realtime session established (model=%s).', self._model)
        return connection

    async def _dispose_session(self, *, reason: str) -> None:
        if self._connection is None:
            return
        connection = self._connection
        self._connection = None
        self._round_trip_count = 0
        self._last_response_completed_at = None
        try:
            await connection.close()
        except Exception:
            logger.warning('Error while closing Realtime connection (reason=%s).', reason, exc_info=True)
        else:
            logger.info('Realtime session disposed (reason=%s).', reason)
