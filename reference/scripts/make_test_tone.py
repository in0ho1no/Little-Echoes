"""task7実機確認用のクリーンな長尺テスト音源（純音メロディ）を生成する。

既存の `scripts/pre_rec_test24sec.wav` は元の録音品質が悪く、長時間再生の音質評価
（途切れ・ノイズ・歪みの検出）に使えないことが実機確認で判明した（2026-07-12）。
本スクリプトは既知のきれいな信号（ペンタトニック音階の純音メロディ）を合成し、
再生経路の品質問題をソース品質と切り分けられるようにする。標準ライブラリのみ使用。

## 使い方（PowerShell）

    uv run python scripts/make_test_tone.py
    uv run python scripts/task7_fw_probe.py --reply scripts/manual_check_output/test_tone_20s.wav

- 出力: 24kHz/16bit/モノラルWAV（既定 `scripts/manual_check_output/test_tone_20s.wav`、
  使い捨て・.gitignore対象。必要になるたび再生成する）
- 各音符に短いフェードを入れてクリック音を防ぎ、振幅は最大の約45%（≈-7dBFS）に抑えて
  スピーカー側の歪みと切り分けられるようにする
"""

import argparse
import math
import wave
from array import array
from pathlib import Path

SAMPLE_RATE_HZ = 24000
"""再生経路と同一のサンプリングレート（docs/SPEC.md §4）。"""

SAMPLE_WIDTH_BYTES = 2  # 16-bit
CHANNELS = 1  # モノラル

DEFAULT_SECONDS = 20.0
DEFAULT_OUTPUT = Path('scripts/manual_check_output/test_tone_20s.wav')

NOTE_FREQUENCIES_HZ = (523.25, 659.25, 783.99, 880.00, 783.99, 659.25)
"""Cメジャーペンタトニックの上行下行（C5-E5-G5-A5-G5-E5）。耳障りにならない中音域。"""

NOTE_SECONDS = 0.5
FADE_SECONDS = 0.01  # 音符の境界のクリック音防止
AMPLITUDE = 0.45  # フルスケール比（≈-7dBFS。アンプ/スピーカー歪みと切り分けるため控えめ）


def synthesize_melody(seconds: float, sample_rate: int) -> array:
    """指定秒数ぶんの純音メロディを合成して16bitサンプル列を返す。

    Args:
        seconds: 合成する長さ（秒）。
        sample_rate: サンプリングレート（Hz）。

    Returns:
        int16サンプルの配列（モノラル）。
    """
    total_samples = int(seconds * sample_rate)
    note_samples = int(NOTE_SECONDS * sample_rate)
    fade_samples = int(FADE_SECONDS * sample_rate)
    peak = int(32767 * AMPLITUDE)

    samples: array = array('h')
    position = 0
    note_index = 0
    while position < total_samples:
        frequency = NOTE_FREQUENCIES_HZ[note_index % len(NOTE_FREQUENCIES_HZ)]
        count = min(note_samples, total_samples - position)
        for i in range(count):
            envelope = 1.0
            if i < fade_samples:
                envelope = i / fade_samples
            elif i >= count - fade_samples:
                envelope = (count - 1 - i) / fade_samples
            value = peak * envelope * math.sin(2.0 * math.pi * frequency * i / sample_rate)
            samples.append(int(value))
        position += count
        note_index += 1
    return samples


def write_wav(path: Path, samples: array, sample_rate: int) -> None:
    """int16サンプル列をWAVファイルへ書き出す。

    Args:
        path: 出力先（親ディレクトリがなければ作成する）。
        samples: int16サンプルの配列（モノラル）。
        sample_rate: サンプリングレート（Hz）。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as wav_file:
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH_BYTES)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(samples.tobytes())


def main() -> int:
    """引数を解釈してテスト音源を生成する。"""
    parser = argparse.ArgumentParser(description='task7実機確認用のクリーンな長尺テスト音源を生成する')
    parser.add_argument('--seconds', type=float, default=DEFAULT_SECONDS, help='生成する長さ（秒）')
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT, help='出力WAVパス')
    args = parser.parse_args()

    samples = synthesize_melody(args.seconds, SAMPLE_RATE_HZ)
    write_wav(args.output, samples, SAMPLE_RATE_HZ)
    size_bytes = len(samples) * SAMPLE_WIDTH_BYTES
    print(f'{args.output} を生成しました（{args.seconds:.1f}s, {size_bytes}bytes, 24kHz/16bit/mono）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
