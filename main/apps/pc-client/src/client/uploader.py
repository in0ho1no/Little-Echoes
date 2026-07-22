"""デバイスAPIへのHTTPSアップロードと解析開始・状態ポーリング。

トークンは環境変数または起動時入力からのみ受け取り、ログ・例外文字列へ
含めない。自動再試行は1回だけで、以降は明示的な再試行操作を待つ。
"""

import json
import secrets
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

from client.spool import ClipMetadata, Spool

TransportResponse = tuple[int, bytes]
Transport = Callable[[urllib.request.Request], TransportResponse]


class UploadRejectedError(Exception):
    """再試行しても成功しない拒否応答(4xx)。"""

    def __init__(self, code: str, message: str) -> None:
        """機械判定用のコードと表示用メッセージを保持する。"""
        super().__init__(message)
        self.code = code


class UploadRetryableError(Exception):
    """一時的な失敗。自動再試行は1回、以降は手動操作を待つ。"""


def _default_transport(request: urllib.request.Request) -> TransportResponse:
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


@dataclass
class UploadResult:
    """アップロード成功時のサーバー応答の要約。"""

    recording_id: str
    deduplicated: bool


class DeviceApiClient:
    """デバイストークンでデバイスAPIを呼ぶ薄いHTTPクライアント。"""

    def __init__(self, base_url: str, token: str, transport: Transport | None = None) -> None:
        """実送信はHTTPSだけを許可する。transportはテスト差し替え用。"""
        if not base_url.startswith('https://') and transport is None:
            raise ValueError('デバイスAPIはHTTPSだけを使用します。')
        self._base_url = base_url.rstrip('/')
        self._token = token
        self._transport = transport or _default_transport

    def _request(self, method: str, path: str, body: bytes | None, content_type: str | None) -> tuple[int, dict[str, object]]:
        headers: dict[str, str] = {'Authorization': f'Bearer {self._token}'}
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
            if isinstance(recording_id, str):
                return UploadResult(recording_id, bool(parsed.get('deduplicated')))
            raise UploadRetryableError('応答に記録IDがありません。')
        code = str(parsed.get('code') or 'UPLOAD_FAILED')
        message = str(parsed.get('message') or '送信に失敗しました。')
        retryable = bool(parsed.get('retryable')) or status >= 500
        if retryable:
            raise UploadRetryableError(message)
        raise UploadRejectedError(code, message)

    def start_processing(self, recording_id: str) -> str:
        """解析開始を要求し、受付済みジョブ状態を返す。"""
        status, parsed = self._request('POST', f'/api/v1/recordings/{recording_id}/process', None, None)
        if status == 202:
            return str(parsed.get('status') or 'dispatched')
        code = str(parsed.get('code') or 'PROCESS_FAILED')
        message = str(parsed.get('message') or '解析要求に失敗しました。')
        if bool(parsed.get('retryable')) or status >= 500:
            raise UploadRetryableError(message)
        raise UploadRejectedError(code, message)

    def get_status(self, recording_id: str) -> dict[str, object]:
        """録音の現在状態を取得する。"""
        _status, parsed = self._request('GET', f'/api/v1/recordings/{recording_id}', None, None)
        return parsed


class ClipWorker:
    """スプール済みクリップをアップロード→解析受付まで進める。

    各段階の自動再試行は1回だけ。失敗はスプールへ状態として残し、
    明示的なretry()呼び出しまたは次回起動時のresume()で再開する。
    """

    def __init__(self, spool: Spool, client: DeviceApiClient) -> None:
        """スプールとAPIクライアントを束ねる。"""
        self._spool = spool
        self._client = client

    def _upload_step(self, meta: ClipMetadata, audio: bytes) -> bool:
        meta.state = 'uploading'
        meta.upload_attempts += 1
        self._spool.update(meta)
        try:
            result = self._client.upload(audio, meta)
        except UploadRetryableError:
            meta.state = 'upload_failed'
            self._spool.update(meta)
            return False
        except UploadRejectedError:
            meta.state = 'upload_failed'
            self._spool.update(meta)
            return False
        self._spool.mark_uploaded(meta, result.recording_id)
        return True

    def _process_step(self, meta: ClipMetadata) -> bool:
        meta.state = 'process_starting'
        meta.process_attempts += 1
        self._spool.update(meta)
        try:
            self._client.start_processing(meta.recording_id or '')
        except (UploadRetryableError, UploadRejectedError):
            meta.state = 'process_start_failed'
            self._spool.update(meta)
            return False
        self._spool.mark_process_accepted(meta)
        return True

    def advance(self, meta: ClipMetadata, *, manual: bool = False) -> str:
        """クリップを1段階以上進め、到達した状態を返す。"""
        if meta.state in ('spooled', 'upload_failed', 'uploading'):
            if meta.state == 'upload_failed' and not manual and meta.upload_attempts >= 2:
                return meta.state
            audio = self._spool.read_audio(meta.client_capture_id)
            if audio is None:
                meta.state = 'spool_failed'
                self._spool.update(meta)
                return meta.state
            if not self._upload_step(meta, audio):
                if not manual and meta.upload_attempts == 1 and not self._upload_step(meta, audio):
                    return meta.state
                if meta.state == 'upload_failed':
                    return meta.state
        if meta.state in ('uploaded', 'process_starting', 'process_start_failed'):
            if meta.state == 'process_start_failed' and not manual and meta.process_attempts >= 2:
                return meta.state
            if self._process_step(meta):
                return 'process_accepted'
        return meta.state

    def resume(self) -> list[str]:
        """起動時に未完了クリップを保持メタデータから再開する。"""
        return [self.advance(meta) for meta in self._spool.entries()]

    def unsent_count(self) -> int:
        """画面表示用の未送信件数。"""
        return self._spool.pending_count()
