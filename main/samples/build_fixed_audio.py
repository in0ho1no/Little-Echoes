"""Phase 7用の固定3音声を成人音声サンプルから再生成する。"""

from __future__ import annotations

import random
import sys
import wave
from array import array
from pathlib import Path

SAMPLE_RATE = 24_000
SAMPLE_WIDTH = 2
CHANNELS = 1
SOURCE = Path(__file__).parents[1] / 'apps' / 'pc-client' / 'src' / 'assets' / 'sample.wav'
OUTPUT_DIRECTORY = Path(__file__).parent / 'audio'


def read_source() -> array[int]:
    """基準WAVを16-bit monoサンプルとして読み込む。"""
    with wave.open(str(SOURCE), 'rb') as source:
        if source.getparams()[:3] != (CHANNELS, SAMPLE_WIDTH, SAMPLE_RATE):
            raise ValueError('source WAV must be 24 kHz / 16-bit / mono')
        samples = array('h')
        samples.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder != 'little':
        samples.byteswap()
    return samples


def segment(samples: array[int], start_seconds: float, end_seconds: float) -> array[int]:
    """秒指定の区間を切り出す。"""
    start = round(start_seconds * SAMPLE_RATE)
    end = round(end_seconds * SAMPLE_RATE)
    if start < 0 or end <= start or end > len(samples):
        raise ValueError('segment range is outside the source WAV')
    return array('h', samples[start:end])


def degrade(samples: array[int]) -> array[int]:
    """成人音声を決定的に低音量・平滑化・加雑音して不明瞭サンプルにする。"""
    generator = random.Random(7_202_607)
    result = array('h')
    previous = 0
    for sample in samples:
        smoothed = (previous * 3 + sample) // 4
        previous = smoothed
        mixed = smoothed // 5 + generator.randint(-1_600, 1_600)
        result.append(max(-32_768, min(32_767, mixed)))
    return result


def write_wav(path: Path, samples: array[int]) -> None:
    """固定形式のWAVを書き出す。"""
    data = array('h', samples)
    if sys.byteorder != 'little':
        data.byteswap()
    with wave.open(str(path), 'wb') as destination:
        destination.setnchannels(CHANNELS)
        destination.setsampwidth(SAMPLE_WIDTH)
        destination.setframerate(SAMPLE_RATE)
        destination.writeframes(data.tobytes())


def build(output_directory: Path) -> None:
    """指定先へ3つの再現用音声を生成する。"""
    samples = read_source()
    output_directory.mkdir(parents=True, exist_ok=True)
    clear_word = segment(samples, 2.5, 6.5)
    short_sentence = segment(samples, 8.0, 13.5)
    write_wav(output_directory / 'clear-word.wav', clear_word)
    write_wav(output_directory / 'short-sentence.wav', short_sentence)
    write_wav(output_directory / 'unclear-utterance.wav', degrade(clear_word))


def main() -> None:
    """追跡対象の配置先へ固定3音声を生成する。"""
    build(OUTPUT_DIRECTORY)


if __name__ == '__main__':
    main()
