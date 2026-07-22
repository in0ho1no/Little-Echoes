"""クラウドに接続しないPhase 1Aの音声取得スパイク。"""

from __future__ import annotations

import argparse
import math
import struct
import threading
import time
import wave
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import sounddevice as sd

TARGET_RATE: Final[int] = 24_000
FALLBACK_RATE: Final[int] = 48_000
SAMPLE_WIDTH: Final[int] = 2
CHANNELS: Final[int] = 1
PRE_ROLL_SECONDS: Final[int] = 10
POST_ROLL_SECONDS: Final[int] = 5
HOLD_SECONDS: Final[float] = 1.5
STATUS_MESSAGE_LIMIT: Final[int] = 16
NORMALIZATION_TARGET_PEAK: Final[int] = 27_000
NORMALIZATION_MIN_PEAK: Final[int] = 256
NORMALIZATION_MAX_GAIN: Final[float] = 8.0
MAX_SAMPLE_VALUE: Final[int] = 32_767
MIN_SAMPLE_VALUE: Final[int] = -32_768


class InputStreamStoppedError(RuntimeError):
    """例外を伴わずに入力ストリームが停止したことを示す。"""


@dataclass(frozen=True)
class CaptureFormat:
    """入力または出力に使うPCM形式。"""

    sample_rate: int
    channels: int = CHANNELS
    sample_width: int = SAMPLE_WIDTH

    @property
    def bytes_per_second(self) -> int:
        """1秒あたりのバイト数を返す。"""
        return self.sample_rate * self.channels * self.sample_width


class ByteRingBuffer:
    """音声コールバックから不変bytesだけを受け取るリングバッファ。"""

    def __init__(self, audio_format: CaptureFormat, seconds: int = PRE_ROLL_SECONDS) -> None:
        """指定秒数分のPCMを保持する。"""
        self._capacity: int = audio_format.bytes_per_second * seconds
        self._blocks: deque[bytes] = deque()
        self._size: int = 0
        self._lock = threading.Lock()

    def append(self, block: bytes) -> None:
        """コールバックからブロッキングI/Oなしで音声を追加する。"""
        immutable_block: bytes = bytes(block)
        with self._lock:
            if len(immutable_block) >= self._capacity:
                self._blocks.clear()
                self._blocks.append(immutable_block[-self._capacity :])
                self._size = self._capacity
                return
            self._blocks.append(immutable_block)
            self._size += len(immutable_block)
            overflow: int = self._size - self._capacity
            while overflow > 0 and self._blocks:
                oldest: bytes = self._blocks.popleft()
                if len(oldest) <= overflow:
                    self._size -= len(oldest)
                    overflow -= len(oldest)
                    continue
                self._blocks.appendleft(oldest[overflow:])
                self._size -= overflow
                overflow = 0

    def clear(self) -> None:
        """後続音声の採取を始める前に内容を破棄する。"""
        with self._lock:
            self._blocks.clear()
            self._size = 0

    def snapshot(self, maximum_bytes: int) -> bytes:
        """末尾から指定バイト数までのスナップショットを返す。"""
        with self._lock:
            blocks: tuple[bytes, ...] = tuple(self._blocks)
        data: bytes = b''.join(blocks)
        return data[-maximum_bytes:]


def downsample_48k_to_24k(pcm: bytes) -> bytes:
    """16-bit mono PCMを隣接サンプル平均で1/2ダウンサンプリングする。"""
    if len(pcm) % 4 != 0:
        raise ValueError('48 kHz PCM must contain complete sample pairs')
    samples: tuple[int, ...] = struct.unpack(f'<{len(pcm) // 2}h', pcm)
    averaged: list[int] = [(samples[index] + samples[index + 1]) // 2 for index in range(0, len(samples), 2)]
    return struct.pack(f'<{len(averaged)}h', *averaged)


def boost_quiet_pcm(pcm: bytes) -> bytes:
    """単発の大きな音を除外して小さい発話だけを上限付きで増幅する。"""
    if len(pcm) % SAMPLE_WIDTH != 0:
        raise ValueError('PCM must contain complete 16-bit samples')
    samples: tuple[int, ...] = struct.unpack(f'<{len(pcm) // SAMPLE_WIDTH}h', pcm)
    if not samples:
        return pcm
    audible_samples: list[int] = sorted(abs(sample) for sample in samples if abs(sample) >= NORMALIZATION_MIN_PEAK)
    if not audible_samples:
        return pcm
    percentile_index: int = math.ceil(len(audible_samples) * 0.95) - 1
    reference_level: int = audible_samples[percentile_index]
    if reference_level >= NORMALIZATION_TARGET_PEAK:
        return pcm
    gain: float = min(NORMALIZATION_TARGET_PEAK / reference_level, NORMALIZATION_MAX_GAIN)
    adjusted: list[int] = [_soft_limit(sample * gain) for sample in samples]
    return struct.pack(f'<{len(adjusted)}h', *adjusted)


def _soft_limit(value: float) -> int:
    """目標ピークを超える突発音だけを滑らかに圧縮する。"""
    magnitude: float = abs(value)
    if magnitude <= NORMALIZATION_TARGET_PEAK:
        return round(value)
    headroom: int = MAX_SAMPLE_VALUE - NORMALIZATION_TARGET_PEAK
    compressed: float = NORMALIZATION_TARGET_PEAK + headroom * (1 - math.exp(-(magnitude - NORMALIZATION_TARGET_PEAK) / headroom))
    limited: int = min(MAX_SAMPLE_VALUE, round(compressed))
    return limited if value >= 0 else max(MIN_SAMPLE_VALUE, -limited)


def write_wav(path: Path, pcm: bytes, audio_format: CaptureFormat) -> None:
    """基準PCMをmono WAVとして保存する。"""
    if audio_format != CaptureFormat(TARGET_RATE):
        raise ValueError('WAV output must use the 24 kHz baseline format')
    with wave.open(str(path), 'wb') as wav_file:
        wav_file.setnchannels(audio_format.channels)
        wav_file.setsampwidth(audio_format.sample_width)
        wav_file.setframerate(audio_format.sample_rate)
        wav_file.writeframes(pcm)


def save_baseline_clip(output_path: Path, pcm: bytes, capture_format: CaptureFormat) -> None:
    """キャプチャPCMを基準形式へ揃えて保存する。"""
    baseline_pcm: bytes = downsample_48k_to_24k(pcm) if capture_format.sample_rate == FALLBACK_RATE else pcm
    write_wav(output_path, boost_quiet_pcm(baseline_pcm), CaptureFormat(TARGET_RATE))


def select_capture_format(device: int | str | None = None) -> CaptureFormat:
    """24 kHzを優先し、利用不可なら48 kHzを選ぶ。"""
    for sample_rate in (TARGET_RATE, FALLBACK_RATE):
        try:
            sd.check_input_settings(device=device, channels=CHANNELS, dtype='int16', samplerate=sample_rate)
        except sd.PortAudioError:
            continue
        return CaptureFormat(sample_rate)
    raise RuntimeError('24 kHz または48 kHzで入力できるマイクを選択してください')


def parse_device(value: str) -> int | str:
    """CLI入力の数値デバイスIDを整数へ変換する。"""
    return int(value) if value.isdecimal() else value


def record_once(output_path: Path, device: int | str | None = None, sleep: Callable[[float], None] = time.sleep) -> None:
    """Enter後の1.5秒待機で長押しを模擬し、15秒クリップを保存する。"""
    capture_format: CaptureFormat = select_capture_format(device)
    # 再接続しても、切断直前に得た音声を失わないよう生存期間を関数全体にする。
    pre_roll: ByteRingBuffer = ByteRingBuffer(capture_format)
    attempts: int = 0
    active_device: int | str | None = device
    while attempts < 2:
        post_roll: ByteRingBuffer = ByteRingBuffer(capture_format, POST_ROLL_SECONDS)
        collecting_post_roll = threading.Event()
        stream_finished = threading.Event()
        status_messages: deque[str] = deque(maxlen=STATUS_MESSAGE_LIMIT)
        pre_pcm: bytes | None = None
        try:

            def callback(
                indata: bytes,
                frames: int,
                time_info: object,
                status: sd.CallbackFlags,
                *,
                pre_roll: ByteRingBuffer = pre_roll,
                post_roll: ByteRingBuffer = post_roll,
                collecting_post_roll: threading.Event = collecting_post_roll,
                status_messages: deque[str] = status_messages,
            ) -> None:
                del frames, time_info
                # コールバックではメモリ上のappend以外をせず、I/Oは呼び出し元へ委ねる。
                # statusは欠落の通知であり、届いたブロック自体は有効な音声なので破棄しない。
                if status:
                    status_messages.append(str(status))
                pre_roll.append(indata)
                if collecting_post_roll.is_set():
                    post_roll.append(indata)

            def finished_callback(*, stream_finished: threading.Event = stream_finished) -> None:
                """終了通知だけを残し、復旧判断は呼び出し元で行う。"""
                stream_finished.set()

            with sd.RawInputStream(
                device=active_device,
                channels=CHANNELS,
                dtype='int16',
                samplerate=capture_format.sample_rate,
                callback=callback,
                finished_callback=finished_callback,
            ):
                input('Enterで記録操作を開始します。1.5秒後に記録を確定します。')
                if stream_finished.is_set():
                    raise InputStreamStoppedError('input stream stopped before capture')
                # 標準入力はキー押下・解放を通知しないため、CLIでは固定待機で長押しを模擬する。
                sleep(HOLD_SECONDS)
                if stream_finished.is_set():
                    raise InputStreamStoppedError('input stream stopped before capture')
                # 長押し成立時点で操作前音声を確定し、直後の5秒を後録りする。
                pre_pcm = pre_roll.snapshot(PRE_ROLL_SECONDS * capture_format.bytes_per_second)
                post_roll.clear()
                collecting_post_roll.set()
                sleep(POST_ROLL_SECONDS)
                collecting_post_roll.clear()
                pcm: bytes = pre_pcm + post_roll.snapshot(POST_ROLL_SECONDS * capture_format.bytes_per_second)
                save_baseline_clip(output_path, pcm, capture_format)
                if status_messages or stream_finished.is_set():
                    print('入力が中断されたため、取得済みの操作後音声までを保存しました。')
                return
        except (sd.PortAudioError, InputStreamStoppedError) as error:
            collecting_post_roll.clear()
            if pre_pcm is not None:
                pcm = pre_pcm + post_roll.snapshot(POST_ROLL_SECONDS * capture_format.bytes_per_second)
                save_baseline_clip(output_path, pcm, capture_format)
                print('入力が中断されたため、取得済みの操作後音声までを保存しました。')
                return
            attempts += 1
            if attempts == 2:
                raise RuntimeError('入力デバイスを再接続できませんでした') from error
            active_device = None


def main() -> None:
    """デバイス一覧または手動録音スパイクを実行する。"""
    parser = argparse.ArgumentParser(description='Little Echoes Phase 1A audio spike')
    parser.add_argument('--record', type=Path, help='保存するWAVパス')
    parser.add_argument('--device', type=parse_device, help='sounddevice入力デバイスIDまたは名称')
    args = parser.parse_args()
    if args.record is None:
        print(sd.query_devices())
        return
    record_once(args.record, args.device)


if __name__ == '__main__':
    main()
