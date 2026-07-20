"""Phase 2のD1初期マイグレーションをSQLiteで検証する。"""

import sqlite3
from pathlib import Path

import pytest

MIGRATION_PATH = Path(__file__).parents[3] / 'api-worker' / 'migrations' / '0001_initial.sql'


def apply_migration() -> sqlite3.Connection:
    """メモリ上のSQLiteへ初期マイグレーションを適用する。"""
    connection = sqlite3.connect(':memory:')
    connection.executescript(MIGRATION_PATH.read_text(encoding='utf-8'))
    return connection


def test_initial_migration_creates_required_phase2_tables() -> None:
    """録音、非同期処理、利用量の永続化テーブルを作成する。"""
    connection = apply_migration()
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    table_names = {row[0] for row in rows}
    assert {'recordings', 'async_jobs', 'usage_counters', 'device_tokens'}.issubset(table_names)


def test_initial_migration_enforces_recording_duration_limit() -> None:
    """20秒を超える録音メタデータをD1制約で拒否する。"""
    connection = apply_migration()
    connection.executescript(
        """
        INSERT INTO households VALUES ('household_demo', '2026-07-21T00:00:00Z');
        INSERT INTO sources VALUES ('source_demo', 'household_demo', 'pc', '2026-07-21T00:00:00Z');
        """
    )
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute(
            """
            INSERT INTO recordings (
              id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
              captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds,
              post_roll_truncated, duration_seconds, upload_status, analysis_status, review_status,
              diary_status, image_status, created_at, updated_at
            ) VALUES (
              'rec_demo', 'household_demo', 'source_demo', 'capture_demo', '2026-07-21T00:00:00Z',
              '2026-07-21T00:00:00Z', 'client_clock', 'Asia/Tokyo', '2026-07-21T00:00:00Z', 10, 5,
              0, 20.1, 'reserved', 'pending', 'pending', 'not_started', 'not_requested',
              '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'
            )
            """
        )
