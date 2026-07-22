"""Little Echoes PCクライアントGUI。

ボタンの押下/解放で1.5秒長押しを判定し、10秒前録り＋5秒後録りのクリップを
スプールへ保存してワーカースレッドで送信する。トークンは環境変数
`LITTLE_ECHOES_DEVICE_TOKEN`または起動時の秘密入力からのみ受け取る。
"""

import io
import os
import queue
import threading
import tkinter as tk
import wave
from datetime import UTC, datetime
from pathlib import Path
from tkinter import simpledialog

from audio.spike import POST_ROLL_SECONDS, PRE_ROLL_SECONDS, ByteRingBuffer, boost_quiet_pcm, select_capture_format

from client.spool import ClipMetadata, Spool, SpoolFullError, new_capture_id
from client.uploader import ClipWorker, DeviceApiClient

DEFAULT_BASE_URL = 'https://ingest.in0ho1no.com'
HOLD_SECONDS = 1.5


def default_spool_root() -> Path:
    """`%LOCALAPPDATA%`配下の専用スプールディレクトリを返す。"""
    base = os.environ.get('LOCALAPPDATA')
    root = Path(base) if base else Path.home() / '.little-echoes'
    return root / 'LittleEchoes' / 'spool'


def pcm_to_wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    """16-bit mono PCMを送信形式のWAVバイト列へ包む。"""
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm)
    return buffer.getvalue()


def load_token() -> str:
    """環境変数または秘密入力ダイアログからだけトークンを受け取る。"""
    token = os.environ.get('LITTLE_ECHOES_DEVICE_TOKEN', '').strip()
    if token:
        return token
    prompted = simpledialog.askstring('Little Echoes', 'デバイストークンを入力してください', show='*')
    if not prompted:
        raise SystemExit('デバイストークンが必要です。')
    return prompted.strip()


class ClientApp:
    """入力状態とクリップ送信を分離したGUI本体。

    入力状態(buffering/hold_pending/collecting_post_roll/input_error/reopening)は
    GUIスレッドで遷移させ、保存・送信はワーカースレッドで行いブロッキングI/Oを
    GUIスレッドへ持ち込まない。
    """

    def __init__(self, root: tk.Tk, spool: Spool, worker: ClipWorker) -> None:
        """ウィジェットを構築し、未完了クリップの再開をワーカーで開始する。"""
        self._root = root
        self._spool = spool
        self._worker = worker
        self._events: queue.Queue[str] = queue.Queue()
        self._input_state = 'buffering'
        self._hold_timer: str | None = None
        self._capture_format = select_capture_format()
        self._ring = ByteRingBuffer(self._capture_format, PRE_ROLL_SECONDS)
        self._state_label = tk.Label(root, text='待機中', font=('', 14))
        self._state_label.pack(padx=16, pady=8)
        self._unsent_label = tk.Label(root, text='')
        self._unsent_label.pack()
        button = tk.Button(root, text='押している間の前後を記録', width=32, height=3)
        button.pack(padx=16, pady=8)
        button.bind('<ButtonPress-1>', lambda _event: self.on_press())
        button.bind('<ButtonRelease-1>', lambda _event: self.on_release())
        retry = tk.Button(root, text='未送信を再試行', command=self.retry_unsent)
        retry.pack(pady=4)
        sample = tk.Button(root, text='固定サンプルを送信', command=self.send_fixed_sample)
        sample.pack(pady=4)
        self._sample_path = Path(__file__).resolve().parents[1] / 'assets' / 'sample.wav'
        root.after(200, self._poll_events)
        self._refresh_unsent()
        threading.Thread(target=self._worker_resume, daemon=True).start()

    def _worker_resume(self) -> None:
        self._worker.resume()
        self._events.put('resumed')

    def _refresh_unsent(self) -> None:
        count = self._worker.unsent_count()
        self._unsent_label.config(text=f'未送信 {count} 件' if count else '未送信はありません')

    def _poll_events(self) -> None:
        try:
            while True:
                self._events.get_nowait()
                self._refresh_unsent()
        except queue.Empty:
            pass
        self._root.after(200, self._poll_events)

    def on_press(self) -> None:
        """押下で長押し判定を開始する。buffering以外では無視する。"""
        if self._input_state != 'buffering':
            return
        self._input_state = 'hold_pending'
        self._state_label.config(text='長押し判定中…')
        self._hold_timer = self._root.after(int(HOLD_SECONDS * 1000), self._hold_established)

    def on_release(self) -> None:
        """1.5秒未満の解放は判定を取り消してbufferingへ戻す。"""
        if self._input_state == 'hold_pending' and self._hold_timer:
            self._root.after_cancel(self._hold_timer)
            self._hold_timer = None
            self._input_state = 'buffering'
            self._state_label.config(text='待機中')

    def _hold_established(self) -> None:
        self._input_state = 'collecting_post_roll'
        self._state_label.config(text='後録り中…(5秒)')
        threading.Thread(target=self._capture_clip, daemon=True).start()

    def _capture_clip(self) -> None:
        pre_roll = self._ring.snapshot(self._capture_format.bytes_per_second * PRE_ROLL_SECONDS)
        post_roll, truncated = self._collect_post_roll()
        pcm = boost_quiet_pcm(pre_roll + post_roll)
        self._finish_clip(pcm, truncated)

    def _collect_post_roll(self) -> tuple[bytes, bool]:
        try:
            import sounddevice

            frames = self._capture_format.sample_rate * POST_ROLL_SECONDS
            recorded = sounddevice.rec(frames, samplerate=self._capture_format.sample_rate, channels=1, dtype='int16')
            sounddevice.wait()
            return bytes(recorded.tobytes()), False
        except Exception:
            self._events.put('input_error')
            return b'', True

    def _finish_clip(self, pcm: bytes, truncated: bool) -> None:
        now = datetime.now(UTC)
        meta = ClipMetadata(
            client_capture_id=new_capture_id(),
            captured_at=now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z',
            captured_timezone='Asia/Tokyo',
            pre_roll_seconds=PRE_ROLL_SECONDS,
            post_roll_seconds=POST_ROLL_SECONDS,
            post_roll_truncated=truncated,
        )
        try:
            saved = self._spool.save(pcm_to_wav_bytes(pcm, self._capture_format.sample_rate), meta)
        except SpoolFullError as error:
            message = str(error)
            self._events.put('spool_full')
            self._state_label.after(0, lambda: self._state_label.config(text=message))
            self._input_state = 'buffering'
            return
        self._input_state = 'buffering'
        self._state_label.after(0, lambda: self._state_label.config(text='保存しました。送信中…'))
        self._worker.advance(saved)
        self._events.put('advanced')

    def retry_unsent(self) -> None:
        """未送信クリップを明示操作としてワーカーで再送する。"""

        def run() -> None:
            for meta in self._spool.entries():
                self._worker.advance(meta, manual=True)
            self._events.put('retried')

        threading.Thread(target=run, daemon=True).start()

    def send_fixed_sample(self) -> None:
        """マイクを使わず固定サンプルWAVを送信する。"""
        if not self._sample_path.exists():
            self._state_label.config(text='固定サンプルが見つかりません。')
            return

        def run() -> None:
            now = datetime.now(UTC)
            meta = ClipMetadata(
                client_capture_id=new_capture_id(),
                captured_at=now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z',
                captured_timezone='Asia/Tokyo',
                pre_roll_seconds=PRE_ROLL_SECONDS,
                post_roll_seconds=POST_ROLL_SECONDS,
                post_roll_truncated=False,
            )
            try:
                saved = self._spool.save(self._sample_path.read_bytes(), meta)
            except SpoolFullError:
                self._events.put('spool_full')
                return
            self._worker.advance(saved)
            self._events.put('advanced')

        threading.Thread(target=run, daemon=True).start()


def main() -> None:
    """GUIを起動する。"""
    root = tk.Tk()
    root.title('Little Echoes')
    token = load_token()
    base_url = os.environ.get('LITTLE_ECHOES_BASE_URL', DEFAULT_BASE_URL)
    spool = Spool(default_spool_root())
    worker = ClipWorker(spool, DeviceApiClient(base_url, token))
    ClientApp(root, spool, worker)
    root.mainloop()


if __name__ == '__main__':
    main()
