"""実機接続時のエントリポイント。docs/SPEC.md §7.2 参照。

起動時にCOMポートを自動検出（`--port`で明示指定も可）し、シリアル接続を確立、
READY待ちハンドシェイクを経て、受信待機ループ（`pipeline.run_pipeline`）を開始する。
Realtime APIキーは環境変数 `OPENAI_API_KEY_VIG` から読み込む（`RealtimeClient`が参照する）。

実行例:
    uv run python src/main.py
    uv run python src/main.py --port COM5 --debug-recordings-dir debug_recordings
    uv run python src/main.py --model gpt-realtime-2.1-mini  # Reasoningモデルとの比較用

実機なしでは最終動作確認不可（コードのみ完成させる。実機結合の動作確認は別途行う）。
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

import serial

from device.handshake import wait_for_ready
from device.port_discovery import NoPortAvailableError, select_port
from openai_client.canned_audio import CannedAudio
from openai_client.errors import ApiClientError
from openai_client.realtime_client import MODEL_NAME, RealtimeClient
from pipeline import run_pipeline
from transport.serial_transport import open_serial_transport

logger = logging.getLogger(__name__)

DEFAULT_CANNED_AUDIO_PATH = Path('scripts/canned_thanks.pcm')
"""感謝インテント検出時に再生する定型応答PCM。`scripts/manual_realtime_check.py gen-thanks`で生成する。"""


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='マイコン実機接続用のエントリポイント。')
    parser.add_argument(
        '--port',
        type=str,
        default=None,
        help='接続先COMポートを明示指定する（例: COM5）。省略時はVID自動検出（複数/0件時は対話選択）。',
    )
    parser.add_argument(
        '--canned-audio',
        type=Path,
        default=DEFAULT_CANNED_AUDIO_PATH,
        help='感謝インテント検出時に再生する定型応答PCMのパス。',
    )
    parser.add_argument(
        '--debug-recordings-dir',
        type=Path,
        default=None,
        help='受信録音PCMをタイムスタンプ付きWAVで保存するディレクトリ。省略時は保存しない。',
    )
    parser.add_argument(
        '--model',
        type=str,
        default=MODEL_NAME,
        help=(
            f'使用するRealtimeモデル名（既定: {MODEL_NAME}）。Reasoningモデル gpt-realtime-2.1-mini を指定するとレイテンシ・応答品質を比較できる。'
        ),
    )
    return parser


async def _run(args: argparse.Namespace) -> None:
    """依存を構築し、ポート接続からパイプライン起動までを配線する。

    設定不備（定型応答PCM未生成・APIキー未設定）はポートを開く前に検出できるよう、
    ハードウェア接続より先に検証する。
    """
    canned_audio = CannedAudio(args.canned_audio)
    realtime_client = RealtimeClient(model=args.model)
    logger.info('Using Realtime model: %s', args.model)

    port = args.port if args.port is not None else select_port().device
    logger.info('Connecting to %s...', port)
    transport = open_serial_transport(port)
    try:
        handshake_result = wait_for_ready(transport)
        await run_pipeline(
            transport,
            realtime_client,
            canned_audio,
            pending_recording=handshake_result.pending_recording,
            debug_recordings_dir=args.debug_recordings_dir,
        )
    finally:
        try:
            await realtime_client.cancel()
        finally:
            transport.close()


def main() -> None:
    """CLI引数を解析し、実機接続のメインループを開始する。"""
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    args = _build_arg_parser().parse_args()
    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        logger.info('Interrupted by user; shutting down.')
    except (NoPortAvailableError, ApiClientError, FileNotFoundError, ValueError, serial.SerialException) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
