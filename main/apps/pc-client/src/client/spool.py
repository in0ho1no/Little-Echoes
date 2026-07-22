"""確定クリップのローカルスプール。

WAVとメタデータJSONを`client_capture_id`名で保存し、20件・25 MiB・7日の
上限を強制する。アップロード確認後はWAVだけを削除し、解析受付(202)確認
まで最小メタデータを保持して、再起動後の再開に使う。
"""

import json
import threading
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
    last_error_code: str | None = None
    last_error_message: str | None = None
    last_error_retryable: bool = False


def new_capture_id() -> str:
    """冪等キーになるUUID v4を発行する。"""
    return str(uuid.uuid4())


class Spool:
    """クリップのローカル保存と上限・保持期間の強制。"""

    def __init__(self, root: Path, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        """スプールディレクトリを作成して初期化する。"""
        self._root = root
        self._now = now
        self._lock = threading.RLock()
        root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _validate_capture_id(capture_id: str) -> None:
        """スプール外のパスを指せない正規UUID v4だけを許可する。"""
        try:
            parsed = uuid.UUID(capture_id)
        except (ValueError, AttributeError) as error:
            raise ValueError('client_capture_id must be a UUID v4') from error
        if parsed.version != 4 or str(parsed) != capture_id:
            raise ValueError('client_capture_id must be a canonical UUID v4')

    def _wav_path(self, capture_id: str) -> Path:
        self._validate_capture_id(capture_id)
        return self._root / f'{capture_id}.wav'

    def _meta_path(self, capture_id: str) -> Path:
        self._validate_capture_id(capture_id)
        return self._root / f'{capture_id}.json'

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        """同一ディレクトリの一時ファイルから置換し、途中書き込みを見せない。"""
        temporary = path.with_suffix(f'{path.suffix}.tmp')
        try:
            temporary.write_bytes(data)
            temporary.replace(path)
        except OSError:
            temporary.unlink(missing_ok=True)
            raise

    def _write_meta(self, meta: ClipMetadata) -> None:
        encoded = json.dumps(asdict(meta), ensure_ascii=False).encode('utf-8')
        self._atomic_write(self._meta_path(meta.client_capture_id), encoded)

    def total_bytes(self) -> int:
        """保存中WAVの総バイト数。"""
        with self._lock:
            total = 0
            audio_paths = (*self._root.glob('*.wav'), *self._root.glob('*.wav.tmp'))
            for path in audio_paths:
                try:
                    total += path.stat().st_size
                except OSError:
                    continue
            return total

    def pending_count(self) -> int:
        """未完了クリップ件数。"""
        with self._lock:
            return len(list(self._root.glob('*.json')))

    def save(self, audio: bytes, meta: ClipMetadata) -> ClipMetadata:
        """上限内でクリップを保存する。上限到達時は理由つきで拒否する。"""
        with self._lock:
            self.purge_expired()
            if self.pending_count() >= MAX_ITEMS:
                raise SpoolFullError(f'未送信が{MAX_ITEMS}件に達しています。送信または削除してください。')
            if self.total_bytes() + len(audio) > MAX_TOTAL_BYTES:
                raise SpoolFullError('スプール容量の上限(25 MiB)に達しています。')
            meta.saved_at = self._now().isoformat()
            meta.state = 'spooled'
            meta.last_error_code = None
            meta.last_error_message = None
            meta.last_error_retryable = False
            wav_path = self._wav_path(meta.client_capture_id)
            self._atomic_write(wav_path, audio)
            try:
                self._write_meta(meta)
            except OSError:
                wav_path.unlink(missing_ok=True)
                raise
            return meta

    def entries(self) -> list[ClipMetadata]:
        """保存日時順の未完了一覧。壊れたJSONは削除せず隔離する。"""
        with self._lock:
            found: list[ClipMetadata] = []
            for path in self._root.glob('*.json'):
                try:
                    meta = ClipMetadata(**json.loads(path.read_text(encoding='utf-8')))
                    self._validate_capture_id(meta.client_capture_id)
                    if meta.client_capture_id != path.stem:
                        raise ValueError('metadata filename does not match client_capture_id')
                    found.append(meta)
                except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                    quarantine = path.with_suffix(f'{path.suffix}.corrupt')
                    try:
                        if not quarantine.exists():
                            path.replace(quarantine)
                    except OSError:
                        pass
                    continue
            return sorted(found, key=lambda meta: meta.saved_at)

    def invalid_count(self) -> int:
        """破損メタデータまたは対応メタデータのないWAV件数。"""
        with self._lock:
            valid_ids = {meta.client_capture_id for meta in self.entries()}
            invalid_ids = {path.name.removesuffix('.json.corrupt') for path in self._root.glob('*.json.corrupt')}
            invalid_ids.update(path.stem for path in self._root.glob('*.wav') if path.stem not in valid_ids)
            return len(invalid_ids)

    def read_audio(self, capture_id: str) -> bytes | None:
        """保存済みWAVを読み出す。削除済みならNone。"""
        with self._lock:
            path = self._wav_path(capture_id)
            return path.read_bytes() if path.exists() else None

    def update(self, meta: ClipMetadata) -> None:
        """状態変化をメタデータへ永続化する。"""
        with self._lock:
            self._write_meta(meta)

    def mark_uploaded(self, meta: ClipMetadata, recording_id: str) -> None:
        """R2保存とrecording_id確認後、WAVを削除して最小メタデータを保持する。"""
        with self._lock:
            meta.recording_id = recording_id
            meta.state = 'uploaded'
            meta.last_error_code = None
            meta.last_error_message = None
            meta.last_error_retryable = False
            self._write_meta(meta)
            self._wav_path(meta.client_capture_id).unlink(missing_ok=True)

    def mark_process_accepted(self, meta: ClipMetadata) -> None:
        """解析受付(202)確認後にメタデータも削除し、クリップを完了させる。"""
        with self._lock:
            self._meta_path(meta.client_capture_id).unlink(missing_ok=True)
            self._wav_path(meta.client_capture_id).unlink(missing_ok=True)

    def purge_expired(self) -> int:
        """7日を超えた項目を削除する。"""
        with self._lock:
            cutoff = self._now() - timedelta(days=MAX_AGE_DAYS)
            removed = 0
            for meta in self.entries():
                try:
                    saved = datetime.fromisoformat(meta.saved_at)
                    if saved.tzinfo is None:
                        saved = saved.replace(tzinfo=UTC)
                except (TypeError, ValueError):
                    saved = cutoff
                if saved <= cutoff:
                    self._meta_path(meta.client_capture_id).unlink(missing_ok=True)
                    self._wav_path(meta.client_capture_id).unlink(missing_ok=True)
                    removed += 1
            cutoff_timestamp = cutoff.timestamp()
            for pattern in ('*.corrupt', '*.tmp'):
                for path in self._root.glob(pattern):
                    try:
                        if path.stat().st_mtime <= cutoff_timestamp:
                            path.unlink(missing_ok=True)
                            removed += 1
                    except OSError:
                        continue
            valid_ids = {meta.client_capture_id for meta in self.entries()}
            for path in self._root.glob('*.wav'):
                try:
                    if path.stem not in valid_ids and path.stat().st_mtime <= cutoff_timestamp:
                        path.unlink(missing_ok=True)
                        removed += 1
                except OSError:
                    continue
            return removed
