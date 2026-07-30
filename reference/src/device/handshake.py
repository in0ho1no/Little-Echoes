"""接続ハンドシェイク処理。docs/SPEC.md §3.4 参照。

PC側はポートオープン後（DTRリセットによりマイコンが再起動する可能性を考慮し）、
最大 READY_TIMEOUT_SEC 秒間 READY (0x06) を待ってからリンク確立とみなす。
時間内に届かない場合も、警告ログを出したうえで受信待機に入る
（マイコンが既に起動済みでREADYを逃したケースの救済）。
"""

import logging
import time
from dataclasses import dataclass

from transport.base import Transport
from transport.packet import Command, Packet

logger = logging.getLogger(__name__)

READY_TIMEOUT_SEC = 5.0


@dataclass(frozen=True)
class HandshakeResult:
    """ハンドシェイク結果と待機中に受信した最新の録音パケット。"""

    ready_received: bool
    pending_recording: Packet | None


def wait_for_ready(transport: Transport, timeout: float = READY_TIMEOUT_SEC) -> HandshakeResult:
    """READY (0x06) の受信を待つ。

    タイムアウトした場合、例外は送出せず警告ログを出す。
    呼び出し側はそのまま受信待機へ進んでよい（§3.4の救済ルール）。
    READYより先に受信した録音パケットは最新1件だけ保持し、後段へ引き継ぐ。
    CANCELを受信した場合は、それ以前に保持していた録音を破棄する。

    Args:
        transport: 待ち受けに使うTransport。
        timeout: 最大待機秒数。

    Returns:
        READY受信有無と、待機中に受信した最新の録音パケット。
    """
    pending_recording: Packet | None = None
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            logger.warning('READY not received within %.1f seconds; proceeding to receive-wait anyway.', timeout)
            return HandshakeResult(ready_received=False, pending_recording=pending_recording)

        packet = transport.recv_packet(timeout=remaining)
        if packet is None:
            logger.warning('READY not received within %.1f seconds; proceeding to receive-wait anyway.', timeout)
            return HandshakeResult(ready_received=False, pending_recording=pending_recording)

        if packet.cmd == Command.READY:
            logger.info('READY received.')
            return HandshakeResult(ready_received=True, pending_recording=pending_recording)

        if packet.cmd == Command.RECORDED_AUDIO:
            if pending_recording is not None:
                logger.debug('Replacing previously buffered recording while waiting for handshake.')
            pending_recording = packet
        elif packet.cmd == Command.CANCEL:
            pending_recording = None
            logger.debug('Clearing buffered recording after CANCEL while waiting for handshake.')
        else:
            logger.warning('Discarding unexpected packet (cmd=0x%02X) while waiting for handshake.', packet.cmd)
