"""マイコン⇄PC間のメインパイプライン処理。docs/SPEC.md §7.2 参照。

0x01（録音データ）受信 → 即0x02（受理・処理開始）返送 → Realtime往復 → インテントに応じて
0x03（音声再生要求。エフェクトID 0x00=通常応答／0x01=感謝定型応答）を送信する、という
1サイクルの処理を担う。0x05（キャンセル）受信時はRealtimeセッションを破棄して受信待機に
戻り、`ApiClientError`系の例外は0x04（エラー通知）にまとめて変換する（申し送り8）。

単一OSスレッドのasyncioイベントループで動作させる。Realtime応答を待っている間も、受信待機
（アイドル）中も、ワーカースレッドを追加せず、`Transport.recv_packet(timeout=0)`（ノンブロッキング）
による定期ポーリングと`asyncio.sleep()`を組み合わせて多重に監視する。`recv_packet()`に
非ゼロのtimeoutを渡す同期ブロッキング呼び出しは使わない。これをidle待機側でも行うのは、
`run_pipeline()`の`while True`ループが`asyncio.sleep()`による中断点を持たないと、コルーチンが
一度もイベントループへ制御を返せず、`asyncio`によるキャンセル（`Task.cancel()`/`wait_for`等）が
一切効かなくなるため（実装当初、テストでこの問題が顕在化し発覚した）。Realtime応答待ち中の
ポーリングでは各周回で0x05の有無を先に確認するため、Realtime応答の完了と0x05受信が競合した
場合も0x05が優先され、未送信の応答結果は破棄される。

パーサ状態のフラッシュ方針（申し送り2）: `Transport`実装（`MemoryTransport`等）の
`recv_packet()`は、データが届かない間も内部で`PacketParser.poll_timeout()`を呼び出す。
受信待機中は`IDLE_POLL_STEP_SEC`（既定0.05秒）ごとに、処理中は`CANCEL_POLL_INTERVAL_SEC`
（既定0.05秒）ごとに`recv_packet()`を呼び直すため、いずれも`BODY_TIMEOUT_SEC`（5秒）より
十分短く、パーサのBODY受信タイムアウトはこの定期呼び出しにより自然に検知される。
パイプライン側で明示的にパーサをフラッシュする処理は不要と判断した。
"""

import asyncio
import contextlib
import logging
import time
from pathlib import Path
from typing import Protocol

from debug_utils import RECORDING_SAMPLE_RATE_HZ, log_response_summary, save_debug_recording
from openai_client.canned_audio import CannedAudio, EffectId, build_play_body
from openai_client.errors import ApiClientError
from openai_client.realtime_client import RealtimeReply
from transport.base import Transport
from transport.packet import Command, Packet

logger = logging.getLogger(__name__)

# Realtime応答待ち中、0x05(CANCEL)を検知するための非ブロッキングポーリング間隔。
CANCEL_POLL_INTERVAL_SEC = 0.05

# ファームウェアの診断パケット（デバッグ用・SPEC外。firmware/src/main.cpp の kDiagCommand）。
# マイコン側のエラー遷移・想定外イベントの理由をログへ可視化する。
FIRMWARE_DIAG_CMD = 0x7F

# 診断パケットの理由コード → 説明（firmware/src/main.cpp の DiagReason と対応させる）。
_FIRMWARE_DIAG_REASONS = {
    0x01: 'send of recorded audio (0x01) failed (detail=recorded bytes)',
    0x02: 'recorder start failed (detail=RecorderError)',
    0x03: 'recorder stopped with error (detail=RecorderError)',
    0x04: 'playback start failed (detail=PlaybackError)',
    0x05: 'playback loop error (detail=PlaybackError)',
    0x06: 'accept (0x02) wait timed out after 3s',
    0x07: 'response (0x03/0x04) wait timed out after 35s',
    0x08: 'rx ring overflow dropped bytes (detail=total dropped)',
    0x09: 'PLAY_AUDIO (0x03) received outside thinking state (detail=AppState)',
    0x0A: 'ACCEPT (0x02) received outside waiting state (detail=AppState)',
}

# 受信待機（アイドル）中、次のパケットを待つ際の1回あたりの最大待機秒数
# （この秒数だけパケットが来なければ check_idle_timeout() を呼ぶ）。
IDLE_POLL_INTERVAL_SEC = 1.0

# 受信待機（アイドル）中、非ブロッキングの recv_packet(timeout=0) を呼び直す間隔。
IDLE_POLL_STEP_SEC = 0.05


class RealtimeClientProtocol(Protocol):
    """パイプラインが要求するRealtimeクライアントの最小インターフェース。"""

    async def respond_to_audio(self, pcm_bytes: bytes) -> RealtimeReply:
        """録音PCMを1往復分Realtime APIへ送り、応答を受け取る。"""
        ...

    async def note_playback_duration(self, playback_sec: float) -> None:
        """アイドルタイムアウトの起点を応答再生の終了（推定）まで先送りする。"""
        ...

    async def check_idle_timeout(self) -> bool:
        """アイドル時間が上限を超えていればセッションを破棄する。"""
        ...

    async def cancel(self) -> None:
        """進行中の応答を中止し、セッションを破棄する。"""
        ...


class _CancelledError(Exception):
    """内部用: 処理中に0x05を受信し、Realtime応答結果を破棄したことを示すマーカー。"""


def _log_firmware_diag(packet: Packet) -> None:
    """ファームウェア診断パケット（0x7F）を解読して警告ログへ出す。

    BODYは [reason:1][detail:4 LE] の5バイト。形式が異なる場合も落とさず生バイトを出す。
    """
    if len(packet.body) != 5:
        logger.warning('Firmware diagnostic with unexpected body: %s', packet.body.hex())
        return
    reason = packet.body[0]
    detail = int.from_bytes(packet.body[1:5], 'little')
    description = _FIRMWARE_DIAG_REASONS.get(reason, 'unknown reason')
    logger.warning('Firmware diagnostic: reason=0x%02X (%s) detail=%d', reason, description, detail)


async def run_pipeline(
    transport: Transport,
    realtime_client: RealtimeClientProtocol,
    canned_audio: CannedAudio,
    *,
    pending_recording: Packet | None = None,
    idle_poll_interval: float = IDLE_POLL_INTERVAL_SEC,
    cancel_poll_interval: float = CANCEL_POLL_INTERVAL_SEC,
    debug_recordings_dir: Path | None = None,
) -> None:
    """受信待機ループ本体。呼び出し側が例外（`KeyboardInterrupt`等）で止めるまで無限に回る。

    Args:
        transport: マイコンとのパケット送受信に使うTransport。
        realtime_client: Realtime往復・アイドル判定・キャンセルを提供するクライアント。
        canned_audio: 感謝インテント検出時に再生する定型応答PCM。
        pending_recording: ハンドシェイク待機中に受信済みの録音パケット（申し送り3・4）。
            通常の受信待機へ入る前に、この1件があれば先に処理する。
        idle_poll_interval: 受信待機中に`recv_packet()`を呼び直す間隔（秒）。
        cancel_poll_interval: Realtime応答待ち中に0x05を確認する間隔（秒）。
        debug_recordings_dir: 受信録音PCMをタイムスタンプ付きWAVとして保存するディレクトリ（docs/SPEC.md
            「デバッグ・運用補助」参照）。Noneの場合は保存しない（既定）。
    """
    if pending_recording is not None:
        await _handle_recorded_audio(transport, realtime_client, canned_audio, pending_recording, cancel_poll_interval, debug_recordings_dir)

    while True:
        await process_one_event(
            transport,
            realtime_client,
            canned_audio,
            idle_poll_interval=idle_poll_interval,
            cancel_poll_interval=cancel_poll_interval,
            debug_recordings_dir=debug_recordings_dir,
        )


async def process_one_event(
    transport: Transport,
    realtime_client: RealtimeClientProtocol,
    canned_audio: CannedAudio,
    *,
    idle_poll_interval: float = IDLE_POLL_INTERVAL_SEC,
    cancel_poll_interval: float = CANCEL_POLL_INTERVAL_SEC,
    debug_recordings_dir: Path | None = None,
) -> None:
    """受信待機中のパケットを1件だけ受け取り、対応する処理を行う。

    `run_pipeline()`の1周回分の処理。テストからも直接呼び出せるよう分離している。

    Args:
        transport: マイコンとのパケット送受信に使うTransport。
        realtime_client: Realtime往復・アイドル判定・キャンセルを提供するクライアント。
        canned_audio: 感謝インテント検出時に再生する定型応答PCM。
        idle_poll_interval: パケットが届かなかった場合の`recv_packet()`の待機秒数。
        cancel_poll_interval: RECORDED_AUDIO処理中に0x05を確認する間隔（秒）。
        debug_recordings_dir: 受信録音PCMのWAV保存先ディレクトリ。Noneの場合は保存しない（既定）。
    """
    packet = await _wait_for_packet(transport, idle_poll_interval)
    if packet is None:
        await realtime_client.check_idle_timeout()
        return

    if packet.cmd == Command.RECORDED_AUDIO:
        await _handle_recorded_audio(transport, realtime_client, canned_audio, packet, cancel_poll_interval, debug_recordings_dir)
    elif packet.cmd == Command.CANCEL:
        await realtime_client.cancel()
    elif packet.cmd == FIRMWARE_DIAG_CMD:
        _log_firmware_diag(packet)
    else:
        logger.warning('Discarding unexpected packet (cmd=0x%02X) while waiting for recording.', packet.cmd)


async def _wait_for_packet(transport: Transport, timeout: float) -> Packet | None:
    """イベントループを専有しない非ブロッキングポーリングで、最大timeout秒パケット到着を待つ。

    `Transport.recv_packet(timeout=0)`（非ブロッキング）と`asyncio.sleep()`を組み合わせて
    繰り返す。`recv_packet()`に非ゼロのtimeoutを直接渡すと、その間コルーチンが
    イベントループへ一切制御を返せなくなり、`run_pipeline()`の`while True`ループが
    `asyncio`によるキャンセルを受け付けられなくなるため、この方式を取る。

    Args:
        transport: パケット受信に使うTransport。
        timeout: 待機する最大秒数。

    Returns:
        到着したパケット。timeout秒以内に届かなかった場合はNone。
    """
    deadline = time.monotonic() + timeout
    while True:
        packet = transport.recv_packet(timeout=0)
        if packet is not None:
            return packet
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        await asyncio.sleep(min(IDLE_POLL_STEP_SEC, remaining))


async def _handle_recorded_audio(
    transport: Transport,
    realtime_client: RealtimeClientProtocol,
    canned_audio: CannedAudio,
    packet: Packet,
    cancel_poll_interval: float,
    debug_recordings_dir: Path | None = None,
) -> None:
    logger.info('Received recording (%d bytes = %.2f s); sending 0x02.', len(packet.body), len(packet.body) / 2 / RECORDING_SAMPLE_RATE_HZ)
    transport.send_packet(Command.ACCEPT_PROCESSING)
    if debug_recordings_dir is not None:
        try:
            save_debug_recording(packet.body, debug_recordings_dir)
        except (OSError, ValueError) as exc:
            logger.warning('Failed to save debug recording (%s); continuing Realtime processing.', exc)

    start_time = time.monotonic()
    try:
        reply = await _respond_with_cancel_watch(transport, realtime_client, packet.body, cancel_poll_interval)
    except _CancelledError:
        logger.info('Recording processing cancelled by 0x05; discarding result and returning to receive-wait.')
        return
    except ApiClientError as exc:
        logger.warning('Realtime API call failed (%s); sending error notification.', exc)
        transport.send_packet(Command.ERROR)
        return
    log_response_summary(reply.transcript, time.monotonic() - start_time, reply.usage)

    if not reply.thanks_detected and not reply.audio_pcm:
        # モデルは音声を一切生成しないターンがあり得る（docs/task.md 申し送り13で実観測）。
        # 空PCMの0x03はマイコン側で「何も鳴らさず待機へ復帰」となりユーザーに区別が付かないため、
        # エラー通知（赤点滅）でターン失敗を明示し、セッションを破棄して次の発話をまっさらにする。
        logger.warning('Realtime reply contained no audio; resetting session and sending error notification.')
        await realtime_client.cancel()
        transport.send_packet(Command.ERROR)
        return

    try:
        body = build_play_body(EffectId.THANKS, canned_audio.pcm) if reply.thanks_detected else build_play_body(EffectId.NORMAL, reply.audio_pcm)
    except ValueError as exc:
        logger.warning('Failed to build PLAY_AUDIO body (%s); resetting session and sending error notification.', exc)
        await realtime_client.cancel()
        transport.send_packet(Command.ERROR)
        return
    logger.info('Sending PLAY_AUDIO (%d bytes, effect=0x%02X)...', len(body), body[0])
    transport.send_packet(Command.PLAY_AUDIO, body)
    logger.info('PLAY_AUDIO sent.')
    # マイコンは再生が終わるまで次の発話（ボタン押下）を受け付けないため、アイドル15秒の
    # 起点を再生終了（推定。BODYはエフェクトID1バイト＋PCM）まで先送りする（SPEC §7.2-2 v1.3.3）。
    await realtime_client.note_playback_duration((len(body) - 1) / 2 / RECORDING_SAMPLE_RATE_HZ)


async def _respond_with_cancel_watch(
    transport: Transport,
    realtime_client: RealtimeClientProtocol,
    pcm_bytes: bytes,
    cancel_poll_interval: float,
) -> RealtimeReply:
    """Realtime応答を待ちつつ、0x05(CANCEL)受信を優先的に監視する。

    ワーカースレッドを使わず、`recv_packet(timeout=0)`によるノンブロッキングポーリングと
    `asyncio.sleep()`を組み合わせて多重待機する。ループの各周回でまず0x05の有無を
    確認するため、Realtime応答がちょうど完了したタイミングと0x05受信が競合した場合も
    0x05が優先され、未送信の応答結果は破棄される。

    Raises:
        _CancelledError: 0x05受信によりRealtime応答が破棄された場合。
        ApiClientError: Realtime API呼び出しが失敗した場合（そのまま伝播）。
    """
    task = asyncio.create_task(realtime_client.respond_to_audio(pcm_bytes))
    try:
        while True:
            packet = transport.recv_packet(timeout=0)
            if packet is not None:
                if packet.cmd == Command.CANCEL:
                    await _cancel_task_and_session(task, realtime_client)
                    raise _CancelledError
                if packet.cmd == FIRMWARE_DIAG_CMD:
                    _log_firmware_diag(packet)
                else:
                    logger.warning('Discarding unexpected packet (cmd=0x%02X) while processing recording.', packet.cmd)
            if task.done():
                return task.result()
            await asyncio.sleep(cancel_poll_interval)
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await task


async def _cancel_task_and_session(task: asyncio.Task[RealtimeReply], realtime_client: RealtimeClientProtocol) -> None:
    task.cancel()
    with contextlib.suppress(Exception, asyncio.CancelledError):
        await task
    await realtime_client.cancel()
