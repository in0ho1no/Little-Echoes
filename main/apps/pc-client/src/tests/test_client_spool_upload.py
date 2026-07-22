"""スプール上限・再開・1回だけの自動再試行・トークン非露出を検証する。"""

import urllib.request
from concurrent.futures import ThreadPoolExecutor
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


def test_worker_waits_for_manual_retry_after_process_failures(tmp_path: Path) -> None:
    """自動試行を使い切った解析受付は、再起動では再送せず明示操作を待つ。"""
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
    restarted_worker = ClipWorker(spool, client_with(restart))
    assert restarted_worker.resume() == ['process_start_failed']
    assert len(restart.requests) == 0
    assert restarted_worker.advance(spool.entries()[0], manual=True) == 'process_accepted'
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
    stored = spool.entries()[0]
    assert stored.last_error_code == 'INVALID_WAV'
    assert stored.last_error_message == 'bad'
    assert stored.last_error_retryable is False


def test_spool_rejects_when_byte_limit_reached(tmp_path: Path) -> None:
    """総容量25 MiB到達で理由つきの拒否になる。"""
    spool = Spool(tmp_path)
    spool.save(b'x' * (25 * 1024 * 1024 - 10), metadata())
    with pytest.raises(SpoolFullError, match='25 MiB'):
        spool.save(b'x' * 100, metadata())


def test_rejected_upload_is_not_auto_retried(tmp_path: Path) -> None:
    """4xx拒否(認証・検証エラー)には自動再試行しない。要求は1回だけ。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    rejecting = FakeTransport([(422, b'{"code":"INVALID_WAV","message":"bad","retryable":false}')])
    ClipWorker(spool, client_with(rejecting)).advance(meta)
    assert len(rejecting.requests) == 1


def test_resume_does_not_auto_resend_failed_uploads(tmp_path: Path) -> None:
    """起動時resumeはアップロード失敗クリップを勝手に再送しない。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    meta.state = 'upload_failed'
    meta.upload_attempts = 2
    spool.update(meta)
    transport = FakeTransport([(201, b'{}')])
    results = ClipWorker(spool, client_with(transport)).resume()
    assert results == ['upload_failed']
    assert len(transport.requests) == 0


def test_missing_wav_moves_clip_to_spool_failed(tmp_path: Path) -> None:
    """WAVが欠落したクリップはspool_failedへ収束し、未送信件数から除外される。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    (tmp_path / f'{meta.client_capture_id}.wav').unlink()
    worker = ClipWorker(spool, client_with(FakeTransport([(201, b'{}')])))
    assert worker.advance(meta, manual=True) == 'spool_failed'
    assert worker.unsent_count() == 0


def test_network_error_marks_upload_failed_without_crashing(tmp_path: Path) -> None:
    """接続失敗(トランスポート例外)はupload_failedへ収束し、例外を漏らさない。"""
    from client.uploader import UploadRetryableError

    def broken(_request: urllib.request.Request) -> tuple[int, bytes]:
        raise UploadRetryableError('サーバーへ接続できませんでした。')

    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    worker = ClipWorker(spool, DeviceApiClient('https://ingest.example.test', TOKEN, broken))
    assert worker.advance(meta) == 'upload_failed'
    assert meta.upload_attempts == 2


def test_token_never_written_to_spool_metadata(tmp_path: Path) -> None:
    """トークンはスプールのメタデータJSONへ書かれない。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    stored = (tmp_path / f'{meta.client_capture_id}.json').read_text(encoding='utf-8')
    assert TOKEN not in stored


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
    with pytest.raises(ValueError, match='HTTPS'):
        DeviceApiClient('https://user@ingest.example.test', TOKEN)
    with pytest.raises(ValueError, match='HTTPS'):
        DeviceApiClient('https://ingest.example.test/unexpected-path', TOKEN)


def test_requests_carry_a_non_default_user_agent(tmp_path: Path) -> None:
    """固有のUser-Agentを全要求へ付与する。

    既定のPython-urllib UAはCloudflareのBrowser Integrity Checkに遮断される
    (実機確認2026-07-22でエラーコード1010を確認)。
    """
    transport = FakeTransport([(201, b'{"recording_id":"rec_' + b'd' * 32 + b'"}')])
    api = client_with(transport)
    api.upload(b'RIFFwav', metadata())
    user_agent = transport.requests[0].get_header('User-agent')
    assert user_agent is not None
    assert 'python-urllib' not in user_agent.lower()


def test_retry_budget_survives_restart(tmp_path: Path) -> None:
    """通信途中で終了しても、自動アップロードは初回を含め合計2回を超えない。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    meta.state = 'uploading'
    meta.upload_attempts = 1
    spool.update(meta)

    first_restart = FakeTransport([(500, b'{"retryable":true}')])
    assert ClipWorker(spool, client_with(first_restart)).resume() == ['upload_failed']
    assert len(first_restart.requests) == 1
    stored = spool.entries()[0]
    assert stored.upload_attempts == 2

    second_restart = FakeTransport([(201, b'{"recording_id":"rec_unexpected"}')])
    assert ClipWorker(spool, client_with(second_restart)).resume() == ['upload_failed']
    assert len(second_restart.requests) == 0


def test_process_starting_resumes_within_persisted_budget(tmp_path: Path) -> None:
    """解析要求の通信途中状態は、残っている自動予算内でだけ再開する。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    spool.mark_uploaded(meta, 'rec_' + 'd' * 32)
    meta.state = 'process_starting'
    meta.process_attempts = 1
    spool.update(meta)
    transport = FakeTransport([(202, b'{"async_job_id":"job_z","status":"dispatched"}')])
    assert ClipWorker(spool, client_with(transport)).resume() == ['process_accepted']
    assert len(transport.requests) == 1


def test_http_429_is_retried_once(tmp_path: Path) -> None:
    """429はretryableフィールドがなくても過渡障害として1回だけ自動再試行する。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    transport = FakeTransport(
        [
            (429, b'{"code":"RATE_LIMITED","message":"later"}'),
            (201, b'{"recording_id":"rec_' + b'e' * 32 + b'"}'),
            (202, b'{"async_job_id":"job_rate","status":"dispatched"}'),
        ]
    )
    assert ClipWorker(spool, client_with(transport)).advance(meta) == 'process_accepted'
    assert len(transport.requests) == 3


def test_status_api_rejects_error_responses() -> None:
    """状態取得の4xxを正常データとして扱わず、機械コードを保持する。"""
    rejecting = FakeTransport([(403, b'{"code":"DEMO_WRITE_DISABLED","message":"disabled","retryable":false}')])
    with pytest.raises(UploadRejectedError) as captured:
        client_with(rejecting).get_status('rec_' + 'f' * 32)
    assert captured.value.code == 'DEMO_WRITE_DISABLED'


def test_concurrent_saves_cannot_exceed_item_limit(tmp_path: Path) -> None:
    """並行保存でも件数確認と書き込みを直列化し、20件上限を超えない。"""
    spool = Spool(tmp_path)

    def save_one(_index: int) -> bool:
        try:
            spool.save(b'wav', metadata())
        except SpoolFullError:
            return False
        return True

    with ThreadPoolExecutor(max_workers=8) as executor:
        saved = list(executor.map(save_one, range(MAX_ITEMS + 8)))
    assert sum(saved) == MAX_ITEMS
    assert spool.pending_count() == MAX_ITEMS


def test_corrupt_or_path_mismatched_metadata_is_ignored(tmp_path: Path) -> None:
    """破損JSONや内部ID改変を読み飛ばし、スプール外のパス操作へ使わない。"""
    (tmp_path / 'broken.json').write_bytes(b'\xffnot-json')
    valid_name = '00000000-0000-4000-8000-000000000001'
    (tmp_path / f'{valid_name}.json').write_text(
        '{"client_capture_id":"../../outside","captured_at":"x","captured_timezone":"x",'
        '"pre_roll_seconds":10,"post_roll_seconds":5,"post_roll_truncated":false}',
        encoding='utf-8',
    )
    spool = Spool(tmp_path)
    assert spool.entries() == []
    assert spool.invalid_count() == 2
    assert len(list(tmp_path.glob('*.json.corrupt'))) == 2
    assert spool.purge_expired() == 0


def test_spool_writes_leave_no_temporary_files(tmp_path: Path) -> None:
    """正常な保存・状態更新後に原子的置換用の一時ファイルを残さない。"""
    spool = Spool(tmp_path)
    meta = spool.save(b'RIFFwav', metadata())
    meta.state = 'uploading'
    spool.update(meta)
    assert list(tmp_path.glob('*.tmp')) == []
