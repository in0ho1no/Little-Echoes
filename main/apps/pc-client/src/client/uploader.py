"""デバイスAPIへのHTTPSアップロードと解析開始・状態ポーリング。

トークンは環境変数または起動時入力からのみ受け取り、ログ・例外文字列へ
含めない。自動再試行は1回だけで、以降は明示的な再試行操作を待つ。
"""

import json
import re
import secrets
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from client.spool import ClipMetadata, Spool

TransportResponse = tuple[int, bytes]
Transport = Callable[[urllib.request.Request], TransportResponse]
MAX_AUTOMATIC_ATTEMPTS = 2
RECORDING_ID_PATTERN = re.compile(r'rec_[A-Za-z0-9_-]+')
# 既定のPython-urllib UAはCloudflareのBrowser Integrity Check/Bot Fight Modeに
# 既知のボットシグネチャとして遮断され、Workerへ到達する前に1010で拒否される
# （実機確認2026-07-22で発覚）。固有のUAで到達を保証する。
USER_AGENT = 'LittleEchoesPcClient/1.0'


class UploadRejectedError(Exception):
    """再試行しても成功しない拒否応答(4xx)。"""

    def __init__(self, code: str, message: str, next_action: str | None = None) -> None:
        """機械判定用のコードと表示用メッセージを保持する。"""
        super().__init__(message)
        self.code = code
        self.next_action = next_action


class UploadRetryableError(Exception):
    """一時的な失敗。自動再試行は1回、以降は手動操作を待つ。"""

    def __init__(self, message: str, code: str = 'NETWORK_ERROR', next_action: str | None = None) -> None:
        """機械判定用のコードと安全な表示情報だけを保持する。"""
        super().__init__(message)
        self.code = code
        self.next_action = next_action


def _default_transport(request: urllib.request.Request) -> TransportResponse:
    parsed_url = urlsplit(request.full_url)
    if parsed_url.scheme != 'https' or not parsed_url.hostname or parsed_url.username is not None or parsed_url.password is not None:
        raise ValueError('デバイスAPIはHTTPSだけを使用します。')
    try:
        # 送信直前にHTTPS・ホスト・userinfo不在を再検証するため、file://などのURLスキームには到達しない。
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        # 接続不可・DNS失敗・タイムアウトは過渡障害として扱い、詳細をトークンなしで伝える。
        raise UploadRetryableError('サーバーへ接続できませんでした。') from error


@dataclass
class UploadResult:
    """アップロード成功時のサーバー応答の要約。"""

    recording_id: str
    deduplicated: bool


class DeviceApiClient:
    """デバイストークンでデバイスAPIを呼ぶ薄いHTTPクライアント。"""

    def __init__(self, base_url: str, token: str, transport: Transport | None = None) -> None:
        """実送信はHTTPSだけを許可する。transportはテスト差し替え用。"""
        parsed_url = urlsplit(base_url)
        if (
            parsed_url.scheme != 'https'
            or not parsed_url.hostname
            or parsed_url.username is not None
            or parsed_url.password is not None
            or parsed_url.query
            or parsed_url.fragment
            or parsed_url.path not in ('', '/')
        ):
            raise ValueError('デバイスAPIはHTTPSだけを使用します。')
        self._base_url = base_url.rstrip('/')
        self._token = token
        self._transport = transport or _default_transport

    def _request(self, method: str, path: str, body: bytes | None, content_type: str | None) -> tuple[int, dict[str, object]]:
        headers: dict[str, str] = {'Authorization': f'Bearer {self._token}', 'User-Agent': USER_AGENT}
        if content_type:
            headers['Content-Type'] = content_type
        if body is not None:
            headers['Content-Length'] = str(len(body))
        request = urllib.request.Request(f'{self._base_url}{path}', data=body, headers=headers, method=method)
        status, payload = self._transport(request)
        try:
            parsed = json.loads(payload.decode('utf-8')) if payload else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            parsed = {}
        return status, parsed if isinstance(parsed, dict) else {}

    def upload(self, audio: bytes, meta: ClipMetadata) -> UploadResult:
        """multipartで録音を作成し、記録IDを返す。"""
        boundary = f'----little-echoes-{secrets.token_hex(8)}'
        fields = {
            'client_capture_id': meta.client_capture_id,
            'captured_at': meta.captured_at,
            'captured_timezone': meta.captured_timezone,
            'pre_roll_seconds': str(meta.pre_roll_seconds),
            'post_roll_seconds': str(meta.post_roll_seconds),
            'post_roll_truncated': 'true' if meta.post_roll_truncated else 'false',
        }
        parts: list[bytes] = []
        for name, value in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
        body = b''.join(parts) + audio + f'\r\n--{boundary}--\r\n'.encode()
        status, parsed = self._request('POST', '/api/v1/recordings', body, f'multipart/form-data; boundary={boundary}')
        if status in (200, 201):
            recording_id = parsed.get('recording_id')
            if isinstance(recording_id, str) and RECORDING_ID_PATTERN.fullmatch(recording_id):
                return UploadResult(recording_id, bool(parsed.get('deduplicated')))
            raise UploadRetryableError('応答に記録IDがありません。', 'INVALID_RESPONSE')
        code = str(parsed.get('code') or 'UPLOAD_FAILED')[:80]
        message = str(parsed.get('message') or '送信に失敗しました。')[:200]
        next_action = str(parsed['next_action'])[:200] if isinstance(parsed.get('next_action'), str) else None
        retryable = parsed.get('retryable') is True or status == 429 or status >= 500
        if retryable:
            raise UploadRetryableError(message, code, next_action)
        raise UploadRejectedError(code, message, next_action)

    def start_processing(self, recording_id: str) -> str:
        """解析開始を要求し、受付済みジョブ状態を返す。"""
        if not RECORDING_ID_PATTERN.fullmatch(recording_id):
            raise UploadRejectedError('INVALID_RECORDING_ID', '記録IDが不正です。')
        status, parsed = self._request('POST', f'/api/v1/recordings/{recording_id}/process', None, None)
        if status == 202:
            return str(parsed.get('status') or 'dispatched')
        code = str(parsed.get('code') or 'PROCESS_FAILED')[:80]
        message = str(parsed.get('message') or '解析要求に失敗しました。')[:200]
        next_action = str(parsed['next_action'])[:200] if isinstance(parsed.get('next_action'), str) else None
        if parsed.get('retryable') is True or status == 429 or status >= 500:
            raise UploadRetryableError(message, code, next_action)
        raise UploadRejectedError(code, message, next_action)

    def get_status(self, recording_id: str) -> dict[str, object]:
        """録音の現在状態を取得する。"""
        if not RECORDING_ID_PATTERN.fullmatch(recording_id):
            raise UploadRejectedError('INVALID_RECORDING_ID', '記録IDが不正です。')
        status, parsed = self._request('GET', f'/api/v1/recordings/{recording_id}', None, None)
        if status == 200:
            return parsed
        code = str(parsed.get('code') or 'STATUS_FAILED')[:80]
        message = str(parsed.get('message') or '処理状態を確認できませんでした。')[:200]
        next_action = str(parsed['next_action'])[:200] if isinstance(parsed.get('next_action'), str) else None
        if parsed.get('retryable') is True or status == 429 or status >= 500:
            raise UploadRetryableError(message, code, next_action)
        raise UploadRejectedError(code, message, next_action)


class ClipWorker:
    """スプール済みクリップをアップロード→解析受付まで進める。

    各段階の自動再試行は1回だけ。失敗はスプールへ状態として残し、
    明示的なretry()呼び出しで再開する。通信途中で終了した状態だけは、
    永続化済みの自動試行予算内で次回起動時にresume()する。
    """

    def __init__(self, spool: Spool, client: DeviceApiClient) -> None:
        """スプールとAPIクライアントを束ねる。advanceはロックで直列化する。"""
        self._spool = spool
        self._client = client
        self._lock = threading.Lock()

    def _upload_step(self, meta: ClipMetadata, audio: bytes) -> str:
        meta.state = 'uploading'
        meta.upload_attempts += 1
        self._spool.update(meta)
        try:
            result = self._client.upload(audio, meta)
        except UploadRetryableError as error:
            meta.state = 'upload_failed'
            self._set_error(meta, error, retryable=True)
            self._spool.update(meta)
            return 'retryable'
        except UploadRejectedError as error:
            meta.state = 'upload_failed'
            self._set_error(meta, error, retryable=False)
            self._spool.update(meta)
            return 'rejected'
        self._spool.mark_uploaded(meta, result.recording_id)
        return 'ok'

    def _process_step(self, meta: ClipMetadata) -> str:
        if not meta.recording_id:
            meta.state = 'spool_failed'
            self._spool.update(meta)
            return 'rejected'
        meta.state = 'process_starting'
        meta.process_attempts += 1
        self._spool.update(meta)
        try:
            self._client.start_processing(meta.recording_id)
        except UploadRetryableError as error:
            meta.state = 'process_start_failed'
            self._set_error(meta, error, retryable=True)
            self._spool.update(meta)
            return 'retryable'
        except UploadRejectedError as error:
            meta.state = 'process_start_failed'
            self._set_error(meta, error, retryable=False)
            self._spool.update(meta)
            return 'rejected'
        self._spool.mark_process_accepted(meta)
        return 'ok'

    @staticmethod
    def _set_error(meta: ClipMetadata, error: UploadRejectedError | UploadRetryableError, *, retryable: bool) -> None:
        """秘密情報を含まないAPIエラーだけを再起動後の表示用に残す。"""
        meta.last_error_code = error.code
        message = str(error)
        if error.next_action:
            message = f'{message} {error.next_action}'
        meta.last_error_message = message[:400]
        meta.last_error_retryable = retryable

    def advance(self, meta: ClipMetadata, *, manual: bool = False) -> str:
        """クリップを1段階以上進め、到達した状態を返す。

        自動再試行は過渡障害(retryable)だけに1回。4xx拒否は手動操作を待つ。
        """
        with self._lock:
            return self._advance_locked(meta, manual)

    def _advance_locked(self, meta: ClipMetadata, manual: bool) -> str:
        if meta.state in ('spooled', 'upload_failed', 'uploading'):
            if meta.state == 'upload_failed' and not manual:
                return meta.state
            if not manual and meta.upload_attempts >= MAX_AUTOMATIC_ATTEMPTS:
                meta.state = 'upload_failed'
                self._spool.update(meta)
                return meta.state
            audio = self._spool.read_audio(meta.client_capture_id)
            if audio is None:
                meta.state = 'spool_failed'
                meta.last_error_code = 'LOCAL_AUDIO_MISSING'
                meta.last_error_message = 'ローカル音声が見つかりません。再録音してください。'
                meta.last_error_retryable = False
                self._spool.update(meta)
                return meta.state
            outcome = self._upload_step(meta, audio)
            if outcome == 'retryable' and not manual and meta.upload_attempts < MAX_AUTOMATIC_ATTEMPTS:
                outcome = self._upload_step(meta, audio)
            if outcome != 'ok':
                return meta.state
        if meta.state in ('uploaded', 'process_starting', 'process_start_failed'):
            if meta.state == 'process_start_failed' and not manual:
                return meta.state
            if not manual and meta.process_attempts >= MAX_AUTOMATIC_ATTEMPTS:
                meta.state = 'process_start_failed'
                self._spool.update(meta)
                return meta.state
            outcome = self._process_step(meta)
            if outcome == 'retryable' and not manual and meta.process_attempts < MAX_AUTOMATIC_ATTEMPTS:
                outcome = self._process_step(meta)
            if outcome == 'ok':
                return 'process_accepted'
        return meta.state

    def resume(self) -> list[str]:
        """起動時に未完了クリップを再開する。

        未送信要求の途中状態だけを永続化済み予算内で再開する。失敗状態は
        ユーザーの明示操作を待ち、起動のたびに再送しない。
        """
        results: list[str] = []
        for meta in self._spool.entries():
            results.append(self.advance(meta))
        return results

    def unsent_count(self) -> int:
        """画面表示用の未送信件数（アップロード未完了のものだけを数える）。"""
        return sum(1 for meta in self._spool.entries() if meta.state in ('spooled', 'uploading', 'upload_failed'))

    def process_pending_count(self) -> int:
        """アップロード済みで解析受付または明示再試行を待つ件数。"""
        return sum(1 for meta in self._spool.entries() if meta.state in ('uploaded', 'process_starting', 'process_start_failed'))

    def local_failed_count(self) -> int:
        """WAV欠落などローカルで自動復旧できない件数。"""
        failed_entries = sum(1 for meta in self._spool.entries() if meta.state == 'spool_failed')
        return failed_entries + self._spool.invalid_count()

    def get_status(self, recording_id: str) -> dict[str, object]:
        """GUIの状態ポーラー向けに録音状態を取得する。"""
        return self._client.get_status(recording_id)
