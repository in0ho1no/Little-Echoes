"""api-workerが実行する本番SQLを実SQLiteでコンパイル検証する。"""

import json
import sqlite3
from pathlib import Path

import pytest

API_WORKER_ROOT = Path(__file__).parents[3] / 'api-worker'
MANIFEST_PATH = API_WORKER_ROOT / 'sql-manifest.json'
MIGRATIONS_PATH = API_WORKER_ROOT / 'migrations'


def apply_migrations() -> sqlite3.Connection:
    """メモリ上のSQLiteへ全マイグレーションを適用する。"""
    connection = sqlite3.connect(':memory:')
    for migration in sorted(MIGRATIONS_PATH.glob('*.sql')):
        connection.executescript(migration.read_text(encoding='utf-8'))
    return connection


def load_statements() -> list[str]:
    """vitestが書き出した捕捉済みSQL文の一覧を読み込む。"""
    manifest: dict[str, list[str]] = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    return manifest['statements']


def test_manifest_exists_and_is_populated() -> None:
    """マニフェストが生成済みで、十分な数の文を含む。"""
    statements = load_statements()
    assert len(statements) > 25


@pytest.mark.parametrize('sql', load_statements(), ids=lambda sql: str(sql)[:60])
def test_production_sql_compiles_against_real_schema(sql: str) -> None:
    """全本番SQL文が実スキーマ上でコンパイルできる（曖昧列名・構文非互換の検出）。"""
    connection = apply_migrations()
    parameters = [None] * sql.count('?')
    connection.execute(f'EXPLAIN {sql}', parameters)


def _phase6_recording(connection: sqlite3.Connection, recording_id: str) -> None:
    """Create the minimum approved recording/job relation used by Phase 6 triggers."""
    now = '2026-07-29T00:00:00.000Z'
    connection.execute('INSERT INTO households (id, created_at) VALUES (?, ?)', ('hh_phase6', now))
    connection.execute(
        'INSERT INTO sources (id, household_id, source_type, created_at) VALUES (?, ?, ?, ?)',
        ('source_phase6', 'hh_phase6', 'pc', now),
    )
    connection.execute(
        """INSERT INTO recordings (id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
             captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds, post_roll_truncated,
             duration_seconds, upload_status, analysis_status, review_status, diary_status, image_status, created_at, updated_at)
           VALUES (?, 'hh_phase6', 'source_phase6', ?, ?, ?, 'client_clock', 'UTC', ?, 0, 0, 0,
                   1, 'ready', 'ready', 'approved', 'ready', 'not_requested', ?, ?)""",
        (recording_id, f'capture-{recording_id}', now, now, now, now, now),
    )
    connection.execute(
        'INSERT INTO diary_entries (id, recording_id, version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
        ('diary_phase6', recording_id, now, now),
    )


def test_phase6_quota_triggers_use_real_sqlite_constraints() -> None:
    """Diary/image quota boundaries allow the limit and reject the next attempt."""
    connection = apply_migrations()
    now = '2026-07-29T00:00:00.000Z'
    _phase6_recording(connection, 'rec_phase6')
    connection.execute(
        """INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number,
           correlation_id, created_at, updated_at) VALUES ('job_diary', 'hh_phase6', 'rec_phase6',
           'diary', 'running', 1, 'corr_1', ?, ?)""",
        (now, now),
    )
    connection.execute(
        """INSERT INTO usage_counters (counter_key, household_id, scope, usage_day, used_count,
           reserved_count, updated_at) VALUES ('demo-global:openai_non_image', NULL,
           'openai_non_image', '2026-07-29', 99, 0, ?)""",
        (now,),
    )
    connection.execute(
        """INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind,
           stage, attempt_number, status, retryable, correlation_id, started_at)
           VALUES ('attempt_diary_1', 'hh_phase6', 'rec_phase6', 'job_diary', 'diary',
                   'diary_generation', 1, 'running', 0, 'corr_1', ?)""",
        (now,),
    )
    with pytest.raises(sqlite3.IntegrityError, match='openai_daily_limit_reached'):
        connection.execute(
            """INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind,
               stage, attempt_number, status, retryable, correlation_id, started_at)
               VALUES ('attempt_diary_2', 'hh_phase6', 'rec_phase6', 'job_diary', 'diary',
                       'diary_generation', 2, 'running', 0, 'corr_1', ?)""",
            (now,),
        )
    assert connection.execute(
        "SELECT used_count FROM usage_counters WHERE counter_key = 'demo-global:openai_non_image'",
    ).fetchone() == (100,)

    connection.execute("DELETE FROM usage_counters WHERE counter_key = 'demo-global:openai_non_image'")
    connection.execute(
        """INSERT INTO usage_counters (counter_key, household_id, scope, usage_day, used_count,
           reserved_count, updated_at) VALUES ('demo-global:image_generation', NULL,
           'image_generation', '2026-07-29', 19, 0, ?)""",
        (now,),
    )
    connection.execute(
        """INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number,
           correlation_id, created_at, updated_at) VALUES ('job_image', 'hh_phase6', 'rec_phase6',
           'image', 'running', 1, 'corr_2', ?, ?)""",
        (now, now),
    )
    connection.execute(
        """INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind,
           stage, attempt_number, status, retryable, correlation_id, started_at)
           VALUES ('attempt_image_1', 'hh_phase6', 'rec_phase6', 'job_image', 'image',
                   'image_generation', 1, 'running', 0, 'corr_2', ?)""",
        (now,),
    )
    with pytest.raises(sqlite3.IntegrityError, match='image_daily_limit_reached'):
        connection.execute(
            """INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind,
               stage, attempt_number, status, retryable, correlation_id, started_at)
               VALUES ('attempt_image_daily_2', 'hh_phase6', 'rec_phase6', 'job_image', 'image',
                       'image_generation', 2, 'running', 0, 'corr_2', ?)""",
            (now,),
        )
    assert connection.execute(
        "SELECT used_count FROM usage_counters WHERE counter_key = 'demo-global:image_generation'",
    ).fetchone() == (20,)

    connection.execute(
        "UPDATE usage_counters SET used_count = 0 WHERE counter_key = 'demo-global:image_generation'",
    )
    connection.execute(
        """UPDATE usage_counters SET used_count = 4
           WHERE counter_key = 'recording:rec_phase6:image' AND usage_day = 'lifetime'""",
    )
    connection.execute(
        """INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind,
           stage, attempt_number, status, retryable, correlation_id, started_at)
           VALUES ('attempt_image_lifetime_5', 'hh_phase6', 'rec_phase6', 'job_image', 'image',
                   'image_generation', 2, 'running', 0, 'corr_2', ?)""",
        (now,),
    )
    with pytest.raises(sqlite3.IntegrityError, match='image_lifetime_limit_reached'):
        connection.execute(
            """INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind,
               stage, attempt_number, status, retryable, correlation_id, started_at)
               VALUES ('attempt_image_lifetime_6', 'hh_phase6', 'rec_phase6', 'job_image', 'image',
                       'image_generation', 3, 'running', 0, 'corr_2', ?)""",
            (now,),
        )
    assert connection.execute(
        "SELECT used_count FROM usage_counters WHERE counter_key = 'recording:rec_phase6:image'",
    ).fetchone() == (5,)
    assert connection.execute(
        "SELECT used_count FROM usage_counters WHERE counter_key = 'demo-global:image_generation'",
    ).fetchone() == (1,)
