"""PCクライアントGUIの時刻・切断復旧ロジックをGUIなしで検証する。"""

import queue
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, cast

import client.app as app_module
import pytest
from audio.spike import ByteRingBuffer, CaptureFormat
from client.app import ClientApp


class FakeLabel:
    """最後に設定された表示文だけを保持するラベル。"""

    def __init__(self) -> None:
        """空の表示文で初期化する。"""
        self.text = ''

    def config(self, *, text: str) -> None:
        """tkinter.Label.configと同じ形で表示文を記録する。"""
        self.text = text


class ImmediateThread:
    """対象関数をstart時に同期実行するテスト用スレッド。"""

    def __init__(self, *, target: Callable[[], None], daemon: bool) -> None:
        """実行対象を保持し、daemon指定はテストでは使用しない。"""
        del daemon
        self._target = target

    def start(self) -> None:
        """非同期化せず対象関数を実行する。"""
        self._target()


def test_capture_uses_hold_established_time_and_truncates_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    """切断済み後録りは待たず、長押し成立時刻を保持して確定する。"""
    app = cast(Any, ClientApp.__new__(ClientApp))
    app._capture_stop = threading.Event()
    app._capture_stop.set()
    app._stream_failed = threading.Event()
    app._capture_format = CaptureFormat(24_000)
    app._ring = ByteRingBuffer(app._capture_format, 15)
    app._ring.append(b'\x00\x01\x00\x02')
    emitted: list[tuple[str, str]] = []
    finished: list[tuple[bool, datetime]] = []
    app._emit = lambda kind, payload='': emitted.append((kind, payload))
    app._finish_clip = lambda _pcm, truncated, captured_at: finished.append((truncated, captured_at))
    monkeypatch.setattr(app_module, 'POST_ROLL_SECONDS', 5)

    held_at = datetime(2026, 7, 22, 14, 59, 59, 900_000, tzinfo=UTC)
    app._capture_clip(held_at)

    assert finished == [(True, held_at)]
    assert ('recover_input', '') in emitted


def test_automatic_reopen_is_attempted_only_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """切断が続いても、自動再接続スレッドを無制限に作らない。"""
    app = cast(Any, ClientApp.__new__(ClientApp))
    app._reopening = False
    app._reopen_attempted = False
    app._input_state = 'input_error'
    app._state_label = FakeLabel()
    calls: list[str] = []

    def reopen() -> None:
        calls.append('reopen')
        app._reopening = False

    app._reopen_input = reopen
    monkeypatch.setattr(threading, 'Thread', ImmediateThread)

    app._start_reopen(automatic=True)
    app._start_reopen(automatic=True)

    assert calls == ['reopen']
    assert '自動再接続に失敗' in app._state_label.text


def test_delivery_queue_rejects_duplicate_in_flight_key() -> None:
    """再試行ボタンを連打しても同じ配送処理を複数登録しない。"""
    app = cast(Any, ClientApp.__new__(ClientApp))
    app._delivery_queue = queue.Queue(maxsize=4)
    app._delivery_lock = threading.Lock()
    app._delivery_keys = set()
    emitted: list[tuple[str, str]] = []
    app._emit = lambda kind, payload='': emitted.append((kind, payload))

    assert app._submit_delivery('retry_all', lambda: None) is True
    assert app._submit_delivery('retry_all', lambda: None) is False
    assert app._delivery_queue.qsize() == 1
    assert any('同じ処理を実行中' in payload for _kind, payload in emitted)
