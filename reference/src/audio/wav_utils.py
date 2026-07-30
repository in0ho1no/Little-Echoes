"""RAW PCMデータへのWAVヘッダ付与ユーティリティ。docs/SPEC.md §4, §8 参照。

マイコンから受信するのはヘッダなしRAW PCM（24kHz/16bit/モノラル）であり、
Realtime APIへは無変換で転送するため対話経路では使わない。デバッグ用に
受信録音PCMをタイムスタンプ付きWAVとしてローカル保存する際（§8）に、
このモジュールでヘッダを付与する。
"""

import wave
from io import BytesIO

DEFAULT_SAMPLE_WIDTH_BYTES = 2  # 16-bit
DEFAULT_CHANNELS = 1  # モノラル


def pcm_to_wav_bytes(
    pcm_data: bytes,
    sample_rate: int,
    sample_width: int = DEFAULT_SAMPLE_WIDTH_BYTES,
    channels: int = DEFAULT_CHANNELS,
) -> bytes:
    """ヘッダなしRAW PCMデータにWAVヘッダを付与する。

    Args:
        pcm_data: ヘッダなしのRAW PCMバイト列。
        sample_rate: サンプリングレート（Hz）。
        sample_width: サンプルあたりのバイト数。省略時は2（16-bit）。
        channels: チャンネル数。省略時は1（モノラル）。

    Returns:
        WAVヘッダ付きのバイト列。

    Raises:
        ValueError: sample_width/channelsが正でない場合、またはPCMデータ長が
            1フレームのバイト数に整合しない場合。
    """
    if sample_width <= 0:
        raise ValueError('sample_width must be greater than zero')
    if channels <= 0:
        raise ValueError('channels must be greater than zero')

    frame_size = sample_width * channels
    if len(pcm_data) % frame_size != 0:
        raise ValueError(f'PCM data length {len(pcm_data)} is not aligned to frame size {frame_size}')

    buffer = BytesIO()
    with wave.open(buffer, 'wb') as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_data)
    return buffer.getvalue()
