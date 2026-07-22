"""確定クリップのローカルスプール。

WAVとメタデータJSONを`client_capture_id`名で保存し、20件・25 MiB・7日の
上限を強制する。アップロード確認後はWAVだけを削除し、解析受付(202)確認
まで最小メタデータを保持して、再起動後の再開に使う。
"""

import json
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

MAX_ITEMS = 20
MAX_TOTAL_BYTES = 25 * 1024 * 1024
MAX_AGE_DAYS = 7


class SpoolFullError(Exception):
    """件数・容量・保持期間の上限で新規保存を受け付けられない。"""


@dataclass
class ClipMetadata:
    """クリップ1件の送信・再開に必要な最小メタデータ。"""

    client_capture_id: str
    captured_at: str
    captured_timezone: str
    pre_roll_seconds: int
    post_roll_seconds: int
    post_roll_truncated: bool
    audio_format: str = 'wav_24khz_16bit_mono'
    upload_attempts: int = 0
    process_attempts: int = 0
    recording_id: str | None = None
    state: str = 'spooled'
    saved_at: str = field(default='')


def new_capture_id() -> str:
    """冪等キーになるUUID v4を発行する。"""
    return str(uuid.uuid4())


class Spool:
    """クリップのローカル保存と上限・保持期間の強制。"""

    def __init__(self, root: Path, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        """スプールディレクトリを作成して初期化する。"""
        self._root = root
        self._now = now
        root.mkdir(parents=True, exist_ok=True)

    def _wav_path(self, capture_id: str) -> Path:
        return self._root / f'{capture_id}.wav'

    def _meta_path(self, capture_id: str) -> Path:
        return self._root / f'{capture_id}.json'

    def _write_meta(self, meta: ClipMetadata) -> None:
        self._meta_path(meta.client_capture_id).write_text(json.dumps(asdict(meta), ensure_ascii=False), encoding='utf-8')

    def total_bytes(self) -> int:
        """保存中WAVの総バイト数。"""
        return sum(path.stat().st_size for path in self._root.glob('*.wav'))

    def pending_count(self) -> int:
        """未完了クリップ件数。"""
        return len(list(self._root.glob('*.json')))

    def save(self, audio: bytes, meta: ClipMetadata) -> ClipMetadata:
        """上限内でクリップを保存する。上限到達時は理由つきで拒否する。"""
        self.purge_expired()
        if self.pending_count() >= MAX_ITEMS:
            raise SpoolFullError(f'未送信が{MAX_ITEMS}件に達しています。送信または削除してください。')
        if self.total_bytes() + len(audio) > MAX_TOTAL_BYTES:
            raise SpoolFullError('スプール容量の上限(25 MiB)に達しています。')
        meta.saved_at = self._now().isoformat()
        meta.state = 'spooled'
        self._wav_path(meta.client_capture_id).write_bytes(audio)
        self._write_meta(meta)
        return meta

    def entries(self) -> list[ClipMetadata]:
        """保存日時順の未完了クリップ一覧。壊れたメタデータは読み飛ばす。"""
        found: list[ClipMetadata] = []
        for path in self._root.glob('*.json'):
            try:
                found.append(ClipMetadata(**json.loads(path.read_text(encoding='utf-8'))))
            except (json.JSONDecodeError, TypeError):
                continue
        return sorted(found, key=lambda meta: meta.saved_at)

    def read_audio(self, capture_id: str) -> bytes | None:
        """保存済みWAVを読み出す。削除済みならNone。"""
        path = self._wav_path(capture_id)
        return path.read_bytes() if path.exists() else None

    def update(self, meta: ClipMetadata) -> None:
        """状態変化をメタデータへ永続化する。"""
        self._write_meta(meta)

    def mark_uploaded(self, meta: ClipMetadata, recording_id: str) -> None:
        """R2保存とrecording_id確認後、WAVを削除して最小メタデータを保持する。"""
        meta.recording_id = recording_id
        meta.state = 'uploaded'
        self._write_meta(meta)
        self._wav_path(meta.client_capture_id).unlink(missing_ok=True)

    def mark_process_accepted(self, meta: ClipMetadata) -> None:
        """解析受付(202)確認後にメタデータも削除し、クリップを完了させる。"""
        self._meta_path(meta.client_capture_id).unlink(missing_ok=True)
        self._wav_path(meta.client_capture_id).unlink(missing_ok=True)

    def purge_expired(self) -> int:
        """7日を超えた項目を削除する。"""
        cutoff = self._now() - timedelta(days=MAX_AGE_DAYS)
        removed = 0
        for meta in self.entries():
            try:
                saved = datetime.fromisoformat(meta.saved_at)
            except ValueError:
                saved = cutoff
            if saved <= cutoff:
                self._meta_path(meta.client_capture_id).unlink(missing_ok=True)
                self._wav_path(meta.client_capture_id).unlink(missing_ok=True)
                removed += 1
        return removed
