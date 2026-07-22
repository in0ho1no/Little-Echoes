"""Little Echoes PCクライアントGUI。

ボタンの押下/解放で1.5秒長押しを判定し、10秒前録り＋5秒後録りのクリップを
スプールへ保存してワーカースレッドで送信する。トークンは環境変数
`LITTLE_ECHOES_DEVICE_TOKEN`または起動時の秘密入力からのみ受け取る。
"""

import io
import os
import queue
import threading
import time
import tkinter as tk
import wave
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from tkinter import simpledialog

from audio.spike import (
    POST_ROLL_SECONDS,
    PRE_ROLL_SECONDS,
    ByteRingBuffer,
    CaptureFormat,
    boost_quiet_pcm,
    downsample_48k_to_24k,
    select_capture_format,
)

from client.spool import ClipMetadata, Spool, SpoolFullError, new_capture_id
from client.uploader import ClipWorker, DeviceApiClient, UploadRejectedError, UploadRetryableError

DEFAULT_BASE_URL = 'https://ingest.in0ho1no.com'
HOLD_SECONDS = 1.5
OUTPUT_SAMPLE_RATE = 24_000
DELIVERY_QUEUE_LIMIT = 4
STATUS_QUEUE_LIMIT = 20
STATUS_POLL_INTERVAL_SECONDS = 2.0
STATUS_POLL_TIMEOUT_SECONDS = 15 * 60
STATUS_POLL_RETRY_LIMIT = 1


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
    token = prompted.strip()
    if not token:
        raise SystemExit('デバイストークンが必要です。')
    return token


class ClientApp:
    """入力状態とクリップ送信を分離したGUI本体。

    入力ストリームは常時リングバッファ(前録り10秒+後録り5秒)へ供給する。
    ワーカースレッドはtkウィジェットへ直接触れず、イベントキュー経由で
    GUIスレッドの_poll_eventsだけが画面と入力状態を更新する。
    """

    def __init__(self, root: tk.Tk, spool: Spool, worker: ClipWorker) -> None:
        """ウィジェット構築、入力ストリーム開始、未完了クリップの再開を行う。"""
        self._root = root
        self._spool = spool
        self._worker = worker
        self._events: queue.Queue[tuple[str, str]] = queue.Queue(maxsize=64)
        self._delivery_queue: queue.Queue[tuple[str, Callable[[], None]]] = queue.Queue(maxsize=DELIVERY_QUEUE_LIMIT)
        self._delivery_lock = threading.Lock()
        self._delivery_keys: set[str] = set()
        self._status_queue: queue.Queue[str] = queue.Queue(maxsize=STATUS_QUEUE_LIMIT)
        self._status_lock = threading.Lock()
        self._status_started: dict[str, float] = {}
        self._status_failures: dict[str, int] = {}
        self._input_state = 'buffering'
        self._hold_timer: str | None = None
        self._hold_progress_timer: str | None = None
        self._hold_started_at = 0.0
        self._stream: object | None = None
        self._stream_lock = threading.Lock()
        self._stream_failed = threading.Event()
        self._stream_failure_handled = False
        self._reopen_attempted = False
        self._reopening = False
        self._capture_stop = threading.Event()
        self._has_captured_audio = False
        try:
            self._capture_format = select_capture_format()
            format_available = True
        except RuntimeError:
            self._capture_format = CaptureFormat(OUTPUT_SAMPLE_RATE)
            format_available = False
        self._ring = ByteRingBuffer(self._capture_format, PRE_ROLL_SECONDS + POST_ROLL_SECONDS)
        self._state_label = tk.Label(root, text='待機中', font=('', 14))
        self._state_label.pack(padx=16, pady=8)
        self._delivery_label = tk.Label(root, text='送信待ちはありません')
        self._delivery_label.pack(padx=16, pady=4)
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
        reconnect = tk.Button(root, text='マイクを再接続', command=self.reconnect_input)
        reconnect.pack(pady=4)
        self._sample_path = Path(__file__).resolve().parents[1] / 'assets' / 'sample.wav'
        threading.Thread(target=self._delivery_loop, daemon=True).start()
        threading.Thread(target=self._status_loop, daemon=True).start()
        if not format_available or not self._open_input_stream():
            self._input_state = 'input_error'
            self._stream_failed.set()
            self._state_label.config(text='マイク入力を開始できません。自動再接続を試します。')
        root.after(200, self._poll_events)
        root.protocol('WM_DELETE_WINDOW', self._on_close)
        self._refresh_unsent()
        self._submit_delivery('resume', self._worker_resume)

    def _open_input_stream(self) -> bool:
        """前録り用の入力ストリームを開始し、成否だけを返す。"""
        try:
            import sounddevice

            def callback(indata: bytes, _frames: int, _time_info: object, status: object) -> None:
                if status:
                    self._stream_failed.set()
                self._ring.append(bytes(indata))
                self._has_captured_audio = True

            stream = sounddevice.RawInputStream(
                samplerate=self._capture_format.sample_rate,
                channels=1,
                dtype='int16',
                blocksize=self._capture_format.sample_rate // 10,
                callback=callback,
                finished_callback=self._stream_failed.set,
            )
            stream.start()
            with self._stream_lock:
                self._stream = stream
            self._stream_failed.clear()
            self._stream_failure_handled = False
            return True
        except Exception:
            return False

    def _close_input_stream(self) -> None:
        """入力ストリームを例外を外へ出さずに停止する。"""
        with self._stream_lock:
            stream = self._stream
            self._stream = None
        if stream is None:
            return
        try:
            stop = getattr(stream, 'stop', None)
            close = getattr(stream, 'close', None)
            if callable(stop):
                stop()
            if callable(close):
                close()
        except Exception:
            pass

    def _worker_resume(self) -> None:
        for meta in self._spool.entries():
            state = self._worker.advance(meta)
            if state == 'process_accepted' and meta.recording_id:
                self._enqueue_status_poll(meta.recording_id)
        self._emit('refresh')

    def _emit(self, kind: str, payload: str = '') -> None:
        """音声・通信スレッドを止めずにGUIイベントを有界キューへ渡す。"""
        try:
            self._events.put_nowait((kind, payload))
        except queue.Full:
            try:
                self._events.get_nowait()
            except queue.Empty:
                return
            with suppress(queue.Full):
                self._events.put_nowait((kind, payload))

    def _submit_delivery(self, key: str, operation: Callable[[], None]) -> bool:
        """ネットワーク・スプール処理を単一ワーカーの有界キューへ登録する。"""
        with self._delivery_lock:
            if key in self._delivery_keys:
                self._emit('delivery_message', '同じ処理を実行中です。完了までお待ちください。')
                return False
            self._delivery_keys.add(key)
        try:
            self._delivery_queue.put_nowait((key, operation))
        except queue.Full:
            with self._delivery_lock:
                self._delivery_keys.discard(key)
            self._emit('delivery_message', '送信処理が混み合っています。保存済みデータは未送信として保持します。')
            return False
        return True

    def _delivery_loop(self) -> None:
        while True:
            key, operation = self._delivery_queue.get()
            try:
                operation()
            except Exception:
                self._emit('delivery_message', '送信処理で問題が発生しました。保存済みデータは保持しています。')
            finally:
                with self._delivery_lock:
                    self._delivery_keys.discard(key)
                self._emit('refresh')
                self._delivery_queue.task_done()

    def _enqueue_status_poll(self, recording_id: str) -> None:
        """同じ録音を重複登録せず、最大15分の状態確認を開始する。"""
        with self._status_lock:
            if recording_id in self._status_started:
                return
            self._status_started[recording_id] = time.monotonic()
            self._status_failures[recording_id] = 0
        try:
            self._status_queue.put_nowait(recording_id)
        except queue.Full:
            self._finish_status_poll(recording_id)
            self._emit('delivery_message', '状態確認待ちが上限に達しました。管理画面で処理状況を確認してください。')

    def _finish_status_poll(self, recording_id: str) -> None:
        with self._status_lock:
            self._status_started.pop(recording_id, None)
            self._status_failures.pop(recording_id, None)

    def _requeue_status(self, recording_id: str) -> None:
        time.sleep(STATUS_POLL_INTERVAL_SECONDS)
        try:
            self._status_queue.put_nowait(recording_id)
        except queue.Full:
            self._finish_status_poll(recording_id)
            self._emit('delivery_message', '状態確認待ちが上限に達しました。管理画面で処理状況を確認してください。')

    def _status_loop(self) -> None:
        """API状態を有限時間だけ確認し、処理中・確認待ち・失敗をGUIへ渡す。"""
        while True:
            recording_id = self._status_queue.get()
            try:
                with self._status_lock:
                    started = self._status_started.get(recording_id)
                if started is None:
                    continue
                if time.monotonic() - started >= STATUS_POLL_TIMEOUT_SECONDS:
                    self._finish_status_poll(recording_id)
                    self._emit('delivery_message', '状態確認を終了しました。管理画面で処理状況を確認してください。')
                    continue
                try:
                    current = self._worker.get_status(recording_id)
                except UploadRejectedError as error:
                    self._finish_status_poll(recording_id)
                    message = str(error)[:200] or '処理状態を確認できませんでした。'
                    self._emit('delivery_message', f'{message} 管理画面で確認してください。')
                    continue
                except UploadRetryableError as error:
                    with self._status_lock:
                        failures = self._status_failures.get(recording_id, 0) + 1
                        self._status_failures[recording_id] = failures
                    if failures <= STATUS_POLL_RETRY_LIMIT:
                        self._requeue_status(recording_id)
                    else:
                        self._finish_status_poll(recording_id)
                        message = str(error)[:200] or '処理状態を確認できませんでした。'
                        self._emit('delivery_message', f'{message} 管理画面で確認してください。')
                    continue
                with self._status_lock:
                    self._status_failures[recording_id] = 0
                analysis_status = current.get('analysis_status')
                if analysis_status == 'ready':
                    self._finish_status_poll(recording_id)
                    self._emit('delivery_message', '確認待ちです。スマートフォンで内容を確認できます。')
                elif analysis_status == 'partial':
                    self._finish_status_poll(recording_id)
                    self._emit('delivery_message', '一部の解析結果を確認できます。スマートフォンで補完してください。')
                elif analysis_status == 'failed':
                    self._finish_status_poll(recording_id)
                    self._emit('delivery_message', '解析に失敗しました。スマートフォンから手動入力できます。')
                else:
                    self._emit('delivery_message', 'AI処理中…')
                    self._requeue_status(recording_id)
            finally:
                self._status_queue.task_done()

    def _refresh_unsent(self) -> None:
        unsent = self._worker.unsent_count()
        process_pending = self._worker.process_pending_count()
        local_failed = self._worker.local_failed_count()
        parts: list[str] = []
        if unsent:
            parts.append(f'未送信 {unsent} 件')
        if process_pending:
            parts.append(f'解析受付待ち {process_pending} 件')
        if local_failed:
            parts.append(f'ローカル要確認 {local_failed} 件')
        self._unsent_label.config(text=' / '.join(parts) if parts else '未完了データはありません')

    def _poll_events(self) -> None:
        try:
            while True:
                kind, payload = self._events.get_nowait()
                if kind == 'delivery_message':
                    self._delivery_label.config(text=payload)
                if kind in ('delivery_message', 'refresh'):
                    self._refresh_unsent()
                if kind == 'input_ready' and not self._stream_failed.is_set():
                    self._input_state = 'buffering'
                    self._state_label.config(text=payload or '待機中')
                if kind == 'input_error':
                    self._input_state = 'input_error'
                    self._state_label.config(text=payload)
                if kind == 'recover_input':
                    self._start_reopen(automatic=True)
        except queue.Empty:
            pass
        if self._stream_failed.is_set() and not self._stream_failure_handled:
            self._handle_input_failure()
        self._root.after(200, self._poll_events)

    def _handle_input_failure(self) -> None:
        """切断を1回だけ処理し、後録り中なら取得済み範囲を先に確定する。"""
        self._stream_failure_handled = True
        previous_state = self._input_state
        self._input_state = 'input_error'
        self._state_label.config(text='マイク入力が中断されました。取得済み音声を保護します。')
        if self._hold_timer:
            self._root.after_cancel(self._hold_timer)
            self._hold_timer = None
        if self._hold_progress_timer:
            self._root.after_cancel(self._hold_progress_timer)
            self._hold_progress_timer = None
        if previous_state == 'collecting_post_roll':
            self._capture_stop.set()
            return
        self._start_reopen(automatic=True)

    def _start_reopen(self, *, automatic: bool) -> None:
        if self._reopening:
            return
        if automatic and self._reopen_attempted:
            self._state_label.config(text='自動再接続に失敗しました。「マイクを再接続」を押してください。')
            return
        if automatic:
            self._reopen_attempted = True
        self._reopening = True
        self._input_state = 'reopening'
        self._state_label.config(text='マイクを再接続中…')
        threading.Thread(target=self._reopen_input, daemon=True).start()

    def _reopen_input(self) -> None:
        self._close_input_stream()
        try:
            selected = select_capture_format()
        except RuntimeError:
            selected = None
        if selected is not None and selected != self._capture_format and not self._has_captured_audio:
            self._capture_format = selected
            self._ring = ByteRingBuffer(selected, PRE_ROLL_SECONDS + POST_ROLL_SECONDS)
        opened = selected == self._capture_format and self._open_input_stream()
        self._reopening = False
        if opened:
            self._emit('input_ready', 'マイクを再接続しました。')
        else:
            self._emit('input_error', 'マイクを再接続できません。入力デバイスを確認して再試行してください。')

    def reconnect_input(self) -> None:
        """ユーザーの明示操作で既定入力デバイスへの接続を再試行する。"""
        if self._input_state not in ('input_error', 'reopening'):
            return
        self._start_reopen(automatic=False)

    def on_press(self) -> None:
        """押下で長押し判定を開始する。buffering以外では無視する。"""
        if self._input_state != 'buffering':
            return
        self._input_state = 'hold_pending'
        self._hold_started_at = time.monotonic()
        self._state_label.config(text='長押し判定中… 0%')
        self._hold_timer = self._root.after(int(HOLD_SECONDS * 1000), self._hold_established)
        self._hold_progress_timer = self._root.after(100, self._update_hold_progress)

    def _update_hold_progress(self) -> None:
        if self._input_state != 'hold_pending':
            self._hold_progress_timer = None
            return
        elapsed = time.monotonic() - self._hold_started_at
        percent = min(99, int(elapsed / HOLD_SECONDS * 100))
        self._state_label.config(text=f'長押し判定中… {percent}%')
        self._hold_progress_timer = self._root.after(100, self._update_hold_progress)

    def on_release(self) -> None:
        """1.5秒未満の解放は判定を取り消してbufferingへ戻す。"""
        if self._input_state == 'hold_pending' and self._hold_timer:
            self._root.after_cancel(self._hold_timer)
            self._hold_timer = None
            if self._hold_progress_timer:
                self._root.after_cancel(self._hold_progress_timer)
                self._hold_progress_timer = None
            self._input_state = 'buffering'
            self._state_label.config(text='長押しで記録します。')

    def _hold_established(self) -> None:
        self._hold_timer = None
        if self._hold_progress_timer:
            self._root.after_cancel(self._hold_progress_timer)
            self._hold_progress_timer = None
        self._input_state = 'collecting_post_roll'
        self._state_label.config(text='後録り中…(5秒)')
        self._capture_stop = threading.Event()
        captured_at = datetime.now(UTC)
        threading.Thread(target=self._capture_clip, args=(captured_at,), daemon=True).start()

    def _capture_clip(self, captured_at: datetime) -> None:
        # 後録りは常時稼働の同じ入力ストリームから取る。長押し成立の5秒後に
        # 直近15秒を切り出すと、成立前10秒+成立後5秒のクリップになる。
        interrupted = self._capture_stop.wait(POST_ROLL_SECONDS)
        truncated = interrupted or self._stream_failed.is_set()
        pcm = self._ring.snapshot(self._capture_format.bytes_per_second * (PRE_ROLL_SECONDS + POST_ROLL_SECONDS))
        try:
            if self._capture_format.sample_rate == 48_000:
                pcm = downsample_48k_to_24k(pcm)
            pcm = boost_quiet_pcm(pcm)
            self._finish_clip(pcm, truncated, captured_at)
        except (OSError, ValueError):
            self._emit('delivery_message', '音声クリップを作成できませんでした。マイク設定を確認してください。')
        finally:
            if truncated:
                self._emit('recover_input')
            else:
                self._emit('input_ready')

    def _finish_clip(self, pcm: bytes, truncated: bool, captured_at: datetime) -> None:
        meta = ClipMetadata(
            client_capture_id=new_capture_id(),
            captured_at=captured_at.strftime('%Y-%m-%dT%H:%M:%S.') + f'{captured_at.microsecond // 1000:03d}Z',
            captured_timezone='Asia/Tokyo',
            pre_roll_seconds=PRE_ROLL_SECONDS,
            post_roll_seconds=POST_ROLL_SECONDS,
            post_roll_truncated=truncated,
        )
        try:
            saved = self._spool.save(pcm_to_wav_bytes(pcm, OUTPUT_SAMPLE_RATE), meta)
        except (SpoolFullError, OSError) as error:
            message = str(error) if isinstance(error, SpoolFullError) else 'ローカル保存に失敗しました。空き容量と権限を確認してください。'
            self._emit('delivery_message', message)
            return
        self._emit('delivery_message', '保存しました。送信待ちです。')

        def deliver_saved() -> None:
            self._deliver(saved, fixed_sample=False)

        self._submit_delivery(f'clip:{saved.client_capture_id}', deliver_saved)

    def _deliver(self, saved: ClipMetadata, *, fixed_sample: bool) -> None:
        self._emit('delivery_message', '送信中…')
        state = self._worker.advance(saved)
        if state == 'process_accepted':
            label = '固定サンプルの解析を受け付けました。' if fixed_sample else '解析を受け付けました。'
            self._emit('delivery_message', f'{label} AI処理中…')
            if saved.recording_id:
                self._enqueue_status_poll(saved.recording_id)
            return
        reason = saved.last_error_message or '送信に失敗しました。'
        if saved.last_error_retryable:
            reason = f'{reason} 「未送信を再試行」で再送できます。'
        self._emit('delivery_message', reason)

    def retry_unsent(self) -> None:
        """未送信クリップを明示操作としてワーカーで再送する。"""

        def run() -> None:
            for meta in self._spool.entries():
                state = self._worker.advance(meta, manual=True)
                if state == 'process_accepted' and meta.recording_id:
                    self._enqueue_status_poll(meta.recording_id)
            self._emit('delivery_message', '再試行が完了しました。')

        self._submit_delivery('retry_all', run)

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
            except (SpoolFullError, OSError) as error:
                self._emit('delivery_message', str(error) if isinstance(error, SpoolFullError) else 'ローカル保存に失敗しました。')
                return
            self._deliver(saved, fixed_sample=True)

        self._submit_delivery('fixed_sample', run)

    def _on_close(self) -> None:
        """GUI終了時に入力デバイスを解放する。"""
        self._close_input_stream()
        self._root.destroy()


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
