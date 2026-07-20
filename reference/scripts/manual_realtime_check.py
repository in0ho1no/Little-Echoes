"""Realtime API 実疎通の手動確認スクリプト（タスク12）。

自動テスト対象外（`src/tests/` には含まれず、`uv run pytest` の対象外）。
実際にOpenAI Realtime API（環境変数 `OPENAI_API_KEY_VIG` のキー）を呼び出すため、
実行するたびに課金が発生する。

## 事前準備

環境変数 `OPENAI_API_KEY_VIG` にAPIキーを設定しておくこと。PowerShellのツール実行では
コマンドごとに環境変数がリセットされるため、同一コマンド内で以下を先に実行する
（docs/task.md「環境依存の既知の注意点」参照）。

    $env:OPENAI_API_KEY_VIG = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY_VIG", "User")

## サブコマンド

### respond: 事前録音音声とRealtime APIを1往復させる

    uv run python scripts/manual_realtime_check.py respond --input path/to/recording.wav

- `--input`: 入力ファイル。拡張子が`.wav`ならWAVヘッダを検証したうえでRAW PCMを取り出す
  （24kHz/16bit/モノラルであることを確認し、一致しなければエラーで止まる）。
  それ以外の拡張子（`.pcm`等）はヘッダなしRAW PCMとしてそのまま読み込む。
- `--output-dir`（既定 `scripts/manual_check_output`）: 応答音声をタイムスタンプ付きWAVで保存する。
- `--model`（既定 `gpt-realtime-mini`）: 使用するRealtimeモデル名を上書きする。
  Reasoningモデル `gpt-realtime-2.1-mini` を指定すると、同一入力に対する
  レイテンシ（所要時間ログ）・応答品質・usageを非Reasoningモデルと比較できる。
- transcript・所要時間・usage・感謝インテント検出有無をコンソールへ出力する
  （`src/openai_client/realtime_client.py`・`src/debug_utils.py` の本番コードをそのまま使う）。

### gen-thanks: 定型応答音声「どういたしまして」を生成する

    uv run python scripts/manual_realtime_check.py gen-thanks

- `--output`（既定 `scripts/canned_thanks.pcm`。`manual_check_output/`とは別で、
  使い捨てではない固定アセットとしてコミット対象にする想定）にヘッダなしRAW PCM
  （24kHz/16bit/モノラル）で保存する。ここで生成したファイルパスを、タスク13で
  `CannedAudio`の初期化に使う。生成後、`CannedAudio`で実際に読み込めることも確認する。
- テキスト入力（音声ではなく`conversation.item.create`のtext item）で発話内容を指示するため、
  `RealtimeClient`（音声入力専用）は使わずAPIを直接呼び出す。

## 30秒超応答の打ち切り確認（docs/task.md 申し送り12）

`response.cancel`直後にサーバー側で応答が既に完了していた場合、Realtime APIが
「キャンセル対象なし」の`error`イベントを返す可能性があり、これは現状`RealtimeError`に
なる。`respond`に`--instructions`を渡すとセッションのinstructionsを上書きできるので、
意図的に長い応答を発生させてこの競合が実際に起きないか確認できる。

    uv run python scripts/manual_realtime_check.py respond --input path/to/long_prompt.wav `
        --instructions "できるだけ長く、詳細に、日本語で話し続けてください。短くまとめないでください。"

打ち切り自体が発生したかは、コンソールに出る `Response audio exceeded the ... byte cap`
ログ（`realtime_client.py`が出力）で判別できる。打ち切り後に`RealtimeError`で
異常終了した場合はこの競合が発生している。
"""

import argparse
import asyncio
import base64
import logging
import os
import sys
import time
import wave
from datetime import datetime
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

_SRC_DIR = Path(__file__).resolve().parent.parent / 'src'
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from openai import AsyncOpenAI  # noqa: E402

from audio.wav_utils import pcm_to_wav_bytes  # noqa: E402
from debug_utils import RECORDING_SAMPLE_RATE_HZ, log_response_summary  # noqa: E402
from openai_client.canned_audio import CannedAudio  # noqa: E402
from openai_client.errors import ApiClientError  # noqa: E402
from openai_client.realtime_client import API_KEY_ENV_VAR, MODEL_NAME, RESPONSE_TIMEOUT_SEC, RealtimeClient, RealtimeError  # noqa: E402

logger = logging.getLogger(__name__)

DEFAULT_OUTPUT_DIR = Path('scripts/manual_check_output')
# manual_check_output/ は毎回のrespond実行でタイムスタンプ付きWAVが増え続ける使い捨て
# 出力先（.gitignore対象）。canned_thanks.pcmはタスク13で使う固定アセットのため、
# 事前録音フィクスチャ（pre_rec_*.wav）と同じくscripts/直下をコミット対象の既定保存先とする。
DEFAULT_CANNED_THANKS_PATH = Path('scripts/canned_thanks.pcm')
DEFAULT_THANKS_TEXT = '「どういたしまして」と一言だけ、明るい声で日本語で話してください。'

EXPECTED_SAMPLE_WIDTH_BYTES = 2  # 16-bit
EXPECTED_CHANNELS = 1  # モノラル


def _load_input_pcm(path: Path) -> bytes:
    """入力ファイルからRAW PCM（24kHz/16bit/モノラル）を読み込む。

    拡張子が`.wav`の場合はWAVヘッダを検証したうえでPCM部分のみを取り出す。
    それ以外はヘッダなしRAW PCMとしてそのまま読み込む。

    Raises:
        ValueError: WAVのフォーマットが24kHz/16bit/モノラルと一致しない場合。
    """
    data = path.read_bytes()
    if path.suffix.lower() != '.wav':
        return data

    with wave.open(BytesIO(data), 'rb') as wav_file:
        if wav_file.getframerate() != RECORDING_SAMPLE_RATE_HZ:
            raise ValueError(f'input WAV sample rate {wav_file.getframerate()} != {RECORDING_SAMPLE_RATE_HZ}')
        if wav_file.getsampwidth() != EXPECTED_SAMPLE_WIDTH_BYTES:
            raise ValueError(f'input WAV sample width {wav_file.getsampwidth()} != {EXPECTED_SAMPLE_WIDTH_BYTES} (16-bit)')
        if wav_file.getnchannels() != EXPECTED_CHANNELS:
            raise ValueError(f'input WAV channel count {wav_file.getnchannels()} != {EXPECTED_CHANNELS} (mono)')
        return wav_file.readframes(wav_file.getnframes())


def _save_response_wav(pcm: bytes, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = f'response_{datetime.now().strftime("%Y%m%d_%H%M%S_%f")}.wav'
    path = output_dir / filename
    path.write_bytes(pcm_to_wav_bytes(pcm, sample_rate=RECORDING_SAMPLE_RATE_HZ))
    return path


def _require_api_key() -> str:
    key = os.environ.get(API_KEY_ENV_VAR)
    if not key:
        raise RealtimeError(f'{API_KEY_ENV_VAR} environment variable is not set.')
    return key


def _save_validated_canned_audio(pcm: bytes, output: Path) -> None:
    """検証済みPCMだけを既存アセットと原子的に置換する。

    Args:
        pcm: 保存する24kHz/16bit/モノラルRAW PCM。
        output: 固定アセットの保存先。

    Raises:
        OSError: 一時ファイルの作成・書き込み・置換に失敗した場合。
        ValueError: PCMが空、16-bit境界外、またはBODYサイズ上限を超える場合。
    """
    if not pcm:
        raise ValueError('generated canned audio is empty')
    if len(pcm) % EXPECTED_SAMPLE_WIDTH_BYTES != 0:
        raise ValueError(f'generated canned audio size {len(pcm)} is not aligned to 16-bit samples')

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with NamedTemporaryFile(
            mode='wb',
            dir=output.parent,
            prefix=f'.{output.name}.',
            suffix='.tmp',
            delete=False,
        ) as temporary_file:
            # write()自体が失敗しても後始末できるよう、書き込み前にパスを控える
            # （ファイルはNamedTemporaryFile生成時点で既にディスク上に存在するため）。
            temporary_path = Path(temporary_file.name)
            temporary_file.write(pcm)
        CannedAudio(temporary_path)
        temporary_path.replace(output)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


async def cmd_respond(args: argparse.Namespace) -> None:
    """事前録音音声とRealtime APIを1往復させ、応答を保存・表示する。"""
    pcm_in = _load_input_pcm(args.input)
    duration_sec = len(pcm_in) / (RECORDING_SAMPLE_RATE_HZ * EXPECTED_SAMPLE_WIDTH_BYTES)
    print(f'Loaded input PCM: {len(pcm_in)} bytes (~{duration_sec:.2f}s at {RECORDING_SAMPLE_RATE_HZ}Hz/16bit/mono)')

    client = RealtimeClient(model=args.model, instructions=args.instructions)
    print(f'Using Realtime model: {args.model}')
    start = time.monotonic()
    reply = await client.respond_to_audio(pcm_in)
    elapsed = time.monotonic() - start

    log_response_summary(reply.transcript, elapsed, reply.usage)
    print(f'thanks_detected: {reply.thanks_detected}')
    print(f'response audio: {len(reply.audio_pcm)} bytes')

    if not reply.audio_pcm:
        print('No response audio received (empty).')
        return
    output_path = _save_response_wav(reply.audio_pcm, args.output_dir)
    print(f'Saved response audio to {output_path}')


async def cmd_gen_thanks(args: argparse.Namespace) -> None:
    """テキスト指示でRealtime APIに発話させ、定型応答音声PCMを生成・保存する。

    `RealtimeClient.respond_to_audio()`は音声入力専用のため使わず、
    `conversation.item.create`のtext itemで発話内容を直接指示する。
    """
    api_key = _require_api_key()
    client = AsyncOpenAI(api_key=api_key, max_retries=0)
    session_config: dict[str, Any] = {
        'type': 'realtime',
        'output_modalities': ['audio'],
        'instructions': '与えられた発話指示のとおりに、短い日本語音声でそのまま話してください。',
        'audio': {'output': {'format': {'type': 'audio/pcm', 'rate': RECORDING_SAMPLE_RATE_HZ}}},
    }

    audio_chunks: list[bytes] = []
    transcript: str | None = None
    connection: Any
    # 実SDKの厳密な生成型ではなくAnyとして扱う（realtime_client.pyと同じ方針）。
    async with client.realtime.connect(model=MODEL_NAME) as connection:
        await connection.session.update(session=session_config)
        await connection.conversation.item.create(item={'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': args.text}]})
        await connection.response.create()

        async def _collect() -> None:
            async for event in connection:
                event_type = getattr(event, 'type', None)
                if event_type == 'response.output_audio.delta':
                    audio_chunks.append(base64.b64decode(event.delta))
                elif event_type == 'response.output_audio_transcript.done':
                    nonlocal transcript
                    transcript = event.transcript
                elif event_type == 'error':
                    raise RealtimeError(f'Realtime API returned an error: {event.error.message}')
                elif event_type == 'response.done':
                    if event.response.status != 'completed':
                        raise RealtimeError(f'Realtime API response did not complete (status={event.response.status}).')
                    return

        # RealtimeClientの応答待ちタイムアウトと合わせ、接続が停止した場合に無限に
        # ハングしないようにする（このパスはRealtimeClientを経由しないため個別に必要）。
        await asyncio.wait_for(_collect(), timeout=RESPONSE_TIMEOUT_SEC)

    pcm = b''.join(audio_chunks)
    _save_validated_canned_audio(pcm, args.output)
    print(f'Saved canned audio ({len(pcm)} bytes) to {args.output}')
    print(f'Transcript: {transcript!r}')
    print('Validated: file loads successfully via CannedAudio.')


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Realtime API 実疎通の手動確認スクリプト（自動テスト対象外）。')
    subparsers = parser.add_subparsers(dest='command', required=True)

    respond_parser = subparsers.add_parser('respond', help='事前録音音声とRealtime APIを1往復させる。')
    respond_parser.add_argument('--input', type=Path, required=True, help='入力WAV(.wav)またはRAW PCM(.pcm)ファイル。24kHz/16bit/モノラル。')
    respond_parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT_DIR, help='応答音声WAVの保存先ディレクトリ。')
    respond_parser.add_argument('--instructions', type=str, default=None, help='セッションinstructionsを上書きする（30秒超応答の意図的な発生用）。')
    respond_parser.add_argument(
        '--model', type=str, default=MODEL_NAME, help=f'使用するRealtimeモデル名（既定: {MODEL_NAME}）。Reasoningモデルとの比較用。'
    )
    respond_parser.set_defaults(func=cmd_respond)

    thanks_parser = subparsers.add_parser('gen-thanks', help='定型応答音声「どういたしまして」を生成する。')
    thanks_parser.add_argument('--output', type=Path, default=DEFAULT_CANNED_THANKS_PATH, help='生成したRAW PCMの保存先パス。')
    thanks_parser.add_argument('--text', type=str, default=DEFAULT_THANKS_TEXT, help='読み上げさせる発話指示テキスト。')
    thanks_parser.set_defaults(func=cmd_gen_thanks)

    return parser


def main() -> None:
    """CLI引数を解析し、指定サブコマンドを実行する。"""
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    args = _build_arg_parser().parse_args()
    try:
        asyncio.run(args.func(args))
    except ApiClientError as exc:
        print(f'Realtime API call failed: {exc}', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, wave.Error, TimeoutError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
