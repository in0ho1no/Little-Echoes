"""デバッグ・運用補助（受信録音PCMのWAV保存、応答ログ出力）。docs/SPEC.md「デバッグ・運用補助」参照。

マイクゲイン・音質問題の切り分け用に受信録音PCMをタイムスタンプ付きWAVで保存する機能と、
応答のtranscript・所要時間・usage（取得できる場合）をコンソールログへ出力する機能を提供する。
"""

import logging
from datetime import datetime
from pathlib import Path

from audio.wav_utils import pcm_to_wav_bytes

logger = logging.getLogger(__name__)

# 受信録音PCMのサンプリングレート。docs/SPEC.md「音声データフォーマット仕様」参照。
RECORDING_SAMPLE_RATE_HZ = 24000


def save_debug_recording(pcm_data: bytes, directory: Path, timestamp: datetime | None = None) -> Path:
    """受信録音PCMを、タイムスタンプ付きWAVファイルとしてローカル保存する。

    Args:
        pcm_data: 保存するヘッダなしRAW PCM（24kHz/16bit/モノラル）。
        directory: 保存先ディレクトリ。存在しない場合は作成する。
        timestamp: ファイル名に使う日時。省略時は現在時刻。

    Returns:
        書き込んだWAVファイルのパス。
    """
    directory.mkdir(parents=True, exist_ok=True)
    resolved_timestamp = timestamp if timestamp is not None else datetime.now()
    filename = f'recording_{resolved_timestamp.strftime("%Y%m%d_%H%M%S_%f")}.wav'
    path = directory / filename
    path.write_bytes(pcm_to_wav_bytes(pcm_data, sample_rate=RECORDING_SAMPLE_RATE_HZ))
    return path


def log_response_summary(transcript: str | None, duration_sec: float, usage: dict[str, int] | None = None) -> None:
    """応答のtranscript・所要時間・usageをコンソールログへ出力する。

    Args:
        transcript: Realtime APIが返した文字起こし（取得できなかった場合はNone）。
        duration_sec: Realtime API往復にかかった秒数。
        usage: レスポンスのusage情報（取得できる場合。トークン種別ごとのdict）。
    """
    usage_text = ', '.join(f'{key}={value}' for key, value in usage.items()) if usage else 'N/A'
    logger.info('Realtime response: transcript=%r, duration=%.2fs, usage=[%s]', transcript, duration_sec, usage_text)
