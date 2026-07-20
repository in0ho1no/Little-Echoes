"""定型応答音声（「どういたしまして」等）の読み込みと0x03(PLAY_AUDIO) BODY組み立て。

docs/SPEC.md §3.3, §4 に基づく実装。

定型応答音声の実PCMファイル生成はタスク12（手動確認スクリプト）で行う。
このモジュールでは読み込み・保持と、0x03コマンドBODY（エフェクトID1byte + PCM）の
組み立てのみを扱う。
"""

from enum import IntEnum
from pathlib import Path

from transport.packet import MAX_BODY_SIZE


class EffectId(IntEnum):
    """0x03(PLAY_AUDIO) BODY先頭1バイトのエフェクトID。docs/SPEC.md §3.3参照。"""

    NORMAL = 0x00
    """通常応答（再生中は青の周期明滅）。"""
    THANKS = 0x01
    """お祝い演出（「ありがとう」への定型返答時）。"""


class CannedAudio:
    """定型応答PCMをファイルから読み込み、メモリ上に保持する。

    起動時に1回だけ読み込む想定（タスク10のパイプラインからの利用を想定し、
    呼び出しのたびにファイルI/Oを行わないようにするため）。
    """

    def __init__(self, path: Path) -> None:
        """PCMファイル（ヘッダなしRAW PCM）を読み込んで保持する。

        Args:
            path: 24kHz/16bit/モノラルのRAW PCMファイルパス。

        Raises:
            FileNotFoundError: 指定パスにファイルが存在しない場合。
            ValueError: エフェクトIDを加えたBODYがMAX_BODY_SIZEを超える場合。
        """
        pcm = path.read_bytes()
        body_size = 1 + len(pcm)
        if body_size > MAX_BODY_SIZE:
            raise ValueError(f'canned audio play body size {body_size} exceeds MAX_BODY_SIZE {MAX_BODY_SIZE}')
        self._pcm = pcm

    @property
    def pcm(self) -> bytes:
        """保持しているPCMバイト列。"""
        return self._pcm


def build_play_body(effect_id: int, pcm: bytes) -> bytes:
    """0x03(PLAY_AUDIO) のBODY（エフェクトID1byte + PCM）を組み立てる。

    Args:
        effect_id: エフェクトID（0〜255）。docs/SPEC.md §3.3参照。
        pcm: 再生するPCM RAWバイト列（24kHz/16bit/モノラル）。

    Returns:
        エフェクトID(1byte) + PCM を連結したBODYバイト列。

    Raises:
        ValueError: effect_idが0〜255の範囲外、またはBODY全体（エフェクトID込み）が
            MAX_BODY_SIZE（2MB）を超える場合。
    """
    if not 0 <= effect_id <= 0xFF:
        raise ValueError(f'effect_id {effect_id} is outside the valid range 0..255')
    body = bytes([effect_id]) + pcm
    if len(body) > MAX_BODY_SIZE:
        raise ValueError(f'play body size {len(body)} exceeds MAX_BODY_SIZE {MAX_BODY_SIZE}')
    return body
