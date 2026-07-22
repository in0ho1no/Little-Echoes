"""スプール上限・再開・1回だけの自動再試行・トークン非露出を検証する。"""

import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from client.spool import MAX_ITEMS, ClipMetadata, Spool, SpoolFullError, new_capture_id
from client.uploader import ClipWorker, DeviceApiClient, UploadRejectedError

TOKEN = 'secret-token-value-000000000000000000000000000'


def metadata(capture_id: str | None = None) -> ClipMetadata:
    """テスト用の最小クリップメタデータ。"""
    return ClipMetadata(
        client_capture_id=capture_id or new_capture_id(),
        captured_at='2026-07-22T00:00:00.000Z',
        captured_timezone='Asia/Tokyo',
        pre_roll_seconds=10,
        post_roll_seconds=5,
        post_roll_truncated=False,
    )


class FakeTransport:
    """要求を記録し、あらかじめ決めた応答を返す。"""

    def __init__(self, responses: list[tuple[int, bytes]]) -> None:
        """応答列を受け取る。"""
        self.requests: list[urllib.request.Request] = []
        self._responses = responses

    def __call__(self, request: urllib.request.Request) -> tuple[int, bytes]:
        """要求を記録し、対応する応答を返す。"""
        self.requests.append(request)
        return self._responses[min(len(self.requests) - 1, len(self._responses) - 1)]


def client_with(transport: FakeTransport) -> DeviceApiClient:
    """FakeTransportを注入したクライアント。"""
    return DeviceApiClient('https://ingest.example.test', TOKEN, transport)


def test_spool_rejects_when_item_limit_reached(tmp_path: Path) -> None:
    """20件到達で理由つきの拒否になる。"""
    spool = Spool(tmp_path)
    for _ in range(MAX_ITEMS):
        spool.save(b'wav', metadata())
    with pytest.raises(SpoolFullError, match='20'):
        spool.save(b'wav', metadata())


def test_spool_purges_items_older_than_seven_days(tmp_path: Path) -> None:
    """7日超の項目は次の保存前に削除される。"""
    current = datetime(2026, 7, 22, tzinfo=UTC)
    spool = Spool(tmp_path, now=lambda: current)
    spool.save(b'wav', metadata('00000000-0000-4000-8000-000000000001'))
    current += timedelta(days=8)
    spool.save(b'wav', metadata('00000000-0000-4000-8000-000000000002'))
    remaining = [meta.client_capture_id for meta in spool.entries()]
    assert remaining == ['00000000-0000-4000-8000-000000000002']


def test_worker_retries_upload_once_then_waits_for_manual_retry(tmp_path: Path) -> None:
    """自動再試行は1回だけで、以降はunsent件数に残り手動再開できる。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    failing = FakeTransport([(500, b'{}')])
    worker = ClipWorker(spool, client_with(failing))
    assert worker.advance(meta) == 'upload_failed'
    assert len(failing.requests) == 2
    assert worker.unsent_count() == 1

    succeeding = FakeTransport(
        [
            (201, b'{"recording_id":"rec_' + b'a' * 32 + b'","deduplicated":false}'),
            (202, b'{"async_job_id":"job_x","status":"dispatched"}'),
        ]
    )
    recovered = ClipWorker(spool, client_with(succeeding))
    stored = spool.entries()[0]
    assert recovered.advance(stored, manual=True) == 'process_accepted'
    assert worker.unsent_count() == 0


def test_worker_resumes_process_start_after_restart(tmp_path: Path) -> None:
    """アップロード済みで解析未受付のクリップは、再起動後のresumeで202まで進む。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    upload_only = FakeTransport(
        [
            (201, b'{"recording_id":"rec_' + b'b' * 32 + b'","deduplicated":false}'),
            (500, b'{"retryable":true}'),
            (500, b'{"retryable":true}'),
        ]
    )
    ClipWorker(spool, client_with(upload_only)).advance(meta)
    stored = spool.entries()[0]
    assert stored.state == 'process_start_failed'
    assert stored.recording_id is not None
    assert spool.read_audio(stored.client_capture_id) is None

    restart = FakeTransport([(202, b'{"async_job_id":"job_y","status":"dispatched"}')])
    results = ClipWorker(spool, client_with(restart)).resume()
    assert results == ['process_accepted']
    assert spool.pending_count() == 0
    assert restart.requests[0].get_method() == 'POST'


def test_rejected_upload_keeps_spool_and_reports_code(tmp_path: Path) -> None:
    """4xx拒否はスプールを保持し、コード付き例外を直接送出時に返す。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    rejecting = FakeTransport([(422, b'{"code":"INVALID_WAV","message":"bad","retryable":false}')])
    api = client_with(rejecting)
    with pytest.raises(UploadRejectedError, match='bad'):
        api.upload(b'RIFFwav', meta)
    worker = ClipWorker(spool, api)
    assert worker.advance(meta) == 'upload_failed'
    assert spool.read_audio(meta.client_capture_id) is not None


def test_token_only_in_authorization_header_and_https_enforced(tmp_path: Path) -> None:
    """トークンはAuthorizationヘッダーだけに現れ、非HTTPSの実送信は拒否する。"""
    transport = FakeTransport([(201, b'{"recording_id":"rec_' + b'c' * 32 + b'"}')])
    api = client_with(transport)
    api.upload(b'RIFFwav', metadata())
    request = transport.requests[0]
    assert request.get_header('Authorization') == f'Bearer {TOKEN}'
    body = request.data if isinstance(request.data, bytes) else b''
    assert TOKEN.encode() not in body
    assert TOKEN not in request.full_url
    with pytest.raises(ValueError, match='HTTPS'):
        DeviceApiClient('http://ingest.example.test', TOKEN)
