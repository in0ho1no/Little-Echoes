"""本物のPCパイプライン＋疑似ボタン押下(0x7C)での無人E2E検証ランナー。

main.pyと同じ構成（open_serial_transport→wait_for_ready→run_pipeline＋RealtimeClient）を
そのまま使い、同一トランスポートへ0x7C（疑似ボタン押下。firmware/src/main.cpp参照）を
定期送信して会話サイクルを無人反復する。Realtime APIを実際に呼び、応答音声も実際に再生される。

task8のUSB停止問題（docs/task8_verification.md G）の再現・修正検証に使用した。
押下間隔は既定22秒で、「前ターンの15秒アイドル破棄と次の0x01送信が重なる」タイミングを含む。

使い方:
    $env:OPENAI_API_KEY_VIG = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY_VIG", "User")
    uv run python scripts/task8_e2e_autorun.py --cycles 15
"""

import argparse
import asyncio
import contextlib
import logging
import sys
from pathlib import Path

_PRJ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PRJ / 'src'))

from device.handshake import wait_for_ready  # noqa: E402
from device.port_discovery import select_port  # noqa: E402
from openai_client.canned_audio import CannedAudio  # noqa: E402
from openai_client.realtime_client import RealtimeClient  # noqa: E402
from pipeline import run_pipeline  # noqa: E402
from transport.serial_transport import SerialTransport, open_serial_transport  # noqa: E402

FAKE_PRESS_CMD = 0x7C
LOG_PATH = _PRJ / 'scripts' / 'manual_check_output' / 'task8_e2e_autorun.log'

logger = logging.getLogger('autorun')


async def presser(transport: SerialTransport, args: argparse.Namespace, done: asyncio.Event) -> None:
    """0x7Cを定期送信する。パイプラインと同一イベントループ・同一トランスポートを共有する。"""
    for cycle in range(args.cycles):
        await asyncio.sleep(args.interval if cycle > 0 else 3.0)
        logger.info('=== auto-press %d/%d (hold %dms) ===', cycle + 1, args.cycles, args.hold_ms)
        transport.send_packet(FAKE_PRESS_CMD, args.hold_ms.to_bytes(4, 'little'))
    await asyncio.sleep(30.0)  # 最終サイクルの完了を待つ
    done.set()


async def run(args: argparse.Namespace) -> None:
    """パイプラインとpresserを並走させ、指定回数の無人会話サイクルを実行する。"""
    canned = CannedAudio(_PRJ / 'scripts' / 'canned_thanks.pcm')
    realtime = RealtimeClient()
    port = args.port if args.port is not None else select_port().device
    transport = open_serial_transport(port)
    try:
        wait_for_ready(transport)
        logger.info('READY received; starting pipeline + presser (port=%s)', port)
        done = asyncio.Event()
        pipeline_task = asyncio.create_task(run_pipeline(transport, realtime, canned, debug_recordings_dir=_PRJ / 'debug_recordings'))
        presser_task = asyncio.create_task(presser(transport, args, done))
        await done.wait()
        pipeline_task.cancel()
        presser_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pipeline_task
    finally:
        try:
            await realtime.cancel()
        finally:
            transport.close()
    logger.info('autorun finished')


def main() -> None:
    """引数を解釈し、ログを設定して無人E2Eを開始する。"""
    parser = argparse.ArgumentParser(description='実PCパイプライン＋疑似ボタン押下の無人E2E（0x7C対応FWが必要）')
    parser.add_argument('--port', default=None, help='シリアルポート名（省略時は自動検出）')
    parser.add_argument('--cycles', type=int, default=15, help='会話サイクル数')
    parser.add_argument('--hold-ms', type=int, default=5000, help='疑似押下の保持ミリ秒（1500以上で送信対象の録音になる）')
    parser.add_argument('--interval', type=float, default=22.0, help='押下間隔秒（既定22はアイドル破棄との重なりを含む）')
    args = parser.parse_args()

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s: %(message)s',
        handlers=[logging.StreamHandler(), logging.FileHandler(LOG_PATH, encoding='utf-8')],
    )
    asyncio.run(run(args))


if __name__ == '__main__':
    main()
