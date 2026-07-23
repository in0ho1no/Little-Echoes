"""Phase 5 migration invariants for atomic OpenAI call reservations."""

import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS = ROOT / 'apps' / 'api-worker' / 'migrations'


def database(*, foreign_keys: bool = False) -> sqlite3.Connection:
    connection = sqlite3.connect(':memory:')
    connection.executescript((MIGRATIONS / '0001_initial.sql').read_text(encoding='utf-8'))
    connection.executescript((MIGRATIONS / '0002_phase5_openai.sql').read_text(encoding='utf-8'))
    connection.execute(f'PRAGMA foreign_keys = {"ON" if foreign_keys else "OFF"}')
    return connection


def reserve_word(connection: sqlite3.Connection, attempt: str, day: str) -> None:
    connection.execute(
        "INSERT INTO openai_call_reservations (attempt_id, stage, usage_day, created_at) VALUES (?, 'word_extraction', ?, ?)",
        (attempt, day, f'{day}T00:00:00.000Z'),
    )


def test_word_call_reservation_is_atomic_at_100_and_resets_on_next_utc_day() -> None:
    """単一UPSERTの書き込みロック下で100件目だけを許可し、超過INSERT全体をrollbackする。"""
    connection = database()
    day = '2026-07-23'
    connection.execute(
        """INSERT INTO usage_counters (
          counter_key, household_id, scope, usage_day, used_count, reserved_count, updated_at
        ) VALUES ('demo-global:openai_non_image', NULL, 'openai_non_image', ?, 98, 0, ?)""",
        (day, f'{day}T00:00:00.000Z'),
    )
    reserve_word(connection, 'attempt_1', day)
    reserve_word(connection, 'attempt_2', day)
    assert (
        connection.execute(
            "SELECT used_count FROM usage_counters WHERE counter_key = 'demo-global:openai_non_image' AND usage_day = ?", (day,)
        ).fetchone()[0]
        == 100
    )
    with pytest.raises(sqlite3.IntegrityError, match='openai_daily_limit_reached'):
        reserve_word(connection, 'attempt_3', day)
    assert connection.execute("SELECT COUNT(*) FROM openai_call_reservations WHERE attempt_id = 'attempt_3'").fetchone()[0] == 0
    reserve_word(connection, 'attempt_next_day', '2026-07-24')
    assert (
        connection.execute(
            "SELECT used_count FROM usage_counters WHERE counter_key = 'demo-global:openai_non_image' AND usage_day = '2026-07-24'"
        ).fetchone()[0]
        == 1
    )


def test_transcription_limit_rejection_rolls_back_attempt_and_active_pointer() -> None:
    connection = database()
    at = '2026-07-23T00:00:00.000Z'
    connection.execute("INSERT INTO households (id, created_at) VALUES ('hh', ?)", (at,))
    connection.execute(
        "INSERT INTO sources (id, household_id, source_type, created_at) VALUES ('source', 'hh', 'pc', ?)",
        (at,),
    )
    connection.execute(
        """INSERT INTO recordings (
          id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
          captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds,
          post_roll_truncated, duration_seconds, audio_object_key, audio_sha256, upload_status,
          analysis_status, review_status, diary_status, image_status, created_at, updated_at
        ) VALUES (
          'rec', 'hh', 'source', 'capture', ?, ?, 'client_clock', 'UTC', ?, 0, 0, 0,
          1, 'recordings/rec/audio.wav', ?, 'ready', 'pending', 'pending', 'not_started',
          'not_requested', ?, ?
        )""",
        (at, at, at, 'a' * 64, at, at),
    )
    connection.execute(
        """INSERT INTO async_jobs (
          id, household_id, recording_id, job_type, status, operation_number, correlation_id,
          created_at, updated_at
        ) VALUES ('job', 'hh', 'rec', 'analysis', 'dispatched', 1, 'corr_test', ?, ?)""",
        (at, at),
    )
    connection.execute(
        """INSERT INTO usage_counters (
          counter_key, household_id, scope, usage_day, used_count, reserved_count, updated_at
        ) VALUES ('demo-global:openai_non_image', NULL, 'openai_non_image', '2026-07-23', 100, 0, ?)""",
        (at,),
    )
    with pytest.raises(sqlite3.IntegrityError, match='openai_daily_limit_reached'):
        connection.execute(
            """INSERT INTO processing_attempts (
              id, household_id, recording_id, job_id, processing_kind, stage, attempt_number,
              status, retryable, correlation_id, started_at
            ) VALUES ('attempt', 'hh', 'rec', 'job', 'analysis', 'transcription', 1, 'running', 0, 'corr_test', ?)""",
            (at,),
        )
    assert connection.execute("SELECT COUNT(*) FROM processing_attempts WHERE id = 'attempt'").fetchone()[0] == 0
    assert connection.execute("SELECT active_attempt_id FROM recordings WHERE id = 'rec'").fetchone()[0] is None
    assert (
        connection.execute(
            """SELECT used_count FROM usage_counters
        WHERE counter_key = 'demo-global:openai_non_image' AND usage_day = '2026-07-23'"""
        ).fetchone()[0]
        == 100
    )


def test_deleting_attempt_cascades_its_openai_reservation_with_foreign_keys_enabled() -> None:
    connection = database(foreign_keys=True)
    at = '2026-07-23T00:00:00.000Z'
    connection.execute("INSERT INTO households (id, created_at) VALUES ('hh', ?)", (at,))
    connection.execute("INSERT INTO sources (id, household_id, source_type, created_at) VALUES ('source', 'hh', 'pc', ?)", (at,))
    connection.execute(
        "INSERT INTO device_tokens (id, household_id, source_id, token_hmac, expires_at, created_at) VALUES ('token', 'hh', 'source', ?, ?, ?)",
        ('b' * 64, '2026-07-24T00:00:00.000Z', at),
    )
    connection.execute(
        """INSERT INTO recordings (
          id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
          captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds,
          post_roll_truncated, duration_seconds, audio_object_key, audio_sha256, upload_status,
          analysis_status, review_status, diary_status, image_status, created_at, updated_at
        ) VALUES (
          'rec', 'hh', 'source', 'capture', ?, ?, 'client_clock', 'UTC', ?, 0, 0, 0,
          1, 'recordings/rec/audio.wav', ?, 'ready', 'pending', 'pending', 'not_started',
          'not_requested', ?, ?
        )""",
        (at, at, at, 'a' * 64, at, at),
    )
    connection.execute(
        """INSERT INTO async_jobs (
          id, household_id, recording_id, job_type, status, operation_number, correlation_id,
          created_at, updated_at
        ) VALUES ('job', 'hh', 'rec', 'analysis', 'dispatched', 1, 'corr_test', ?, ?)""",
        (at, at),
    )
    connection.execute(
        """INSERT INTO processing_attempts (
          id, household_id, recording_id, job_id, processing_kind, stage, attempt_number,
          status, retryable, correlation_id, started_at
        ) VALUES ('attempt', 'hh', 'rec', 'job', 'analysis', 'transcription', 1, 'running', 0, 'corr_test', ?)""",
        (at,),
    )
    assert connection.execute("SELECT COUNT(*) FROM openai_call_reservations WHERE attempt_id = 'attempt'").fetchone()[0] == 1
    connection.execute("DELETE FROM processing_attempts WHERE id = 'attempt'")
    assert connection.execute("SELECT COUNT(*) FROM openai_call_reservations WHERE attempt_id = 'attempt'").fetchone()[0] == 0


def test_async_job_authorization_token_reference_uses_set_null_on_token_deletion() -> None:
    connection = database(foreign_keys=True)
    references = connection.execute('PRAGMA foreign_key_list(async_jobs)').fetchall()
    assert any(
        reference[2] == 'device_tokens' and reference[3] == 'authorization_token_id' and reference[6] == 'SET NULL' for reference in references
    )


def test_analysis_job_reservation_atomically_moves_partial_to_pending_or_inserts_nothing() -> None:
    connection = database(foreign_keys=True)
    at = '2026-07-23T00:00:00.000Z'
    connection.execute("INSERT INTO households (id, created_at) VALUES ('hh', ?)", (at,))
    connection.execute("INSERT INTO sources (id, household_id, source_type, created_at) VALUES ('source', 'hh', 'pc', ?)", (at,))
    connection.execute(
        "INSERT INTO device_tokens (id, household_id, source_id, token_hmac, expires_at, created_at) VALUES ('token', 'hh', 'source', ?, ?, ?)",
        ('b' * 64, '2026-07-24T00:00:00.000Z', at),
    )
    connection.execute(
        """INSERT INTO recordings (id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
          captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds, post_roll_truncated,
          duration_seconds, audio_object_key, audio_sha256, upload_status, analysis_status, review_status, diary_status,
          image_status, created_at, updated_at) VALUES ('rec', 'hh', 'source', 'capture', ?, ?, 'client_clock', 'UTC',
          ?, 0, 0, 0, 1, 'recordings/rec/audio.wav', ?, 'ready', 'partial', 'pending', 'not_started', 'not_requested', ?, ?)""",
        (at, at, at, 'a' * 64, at, at),
    )
    connection.execute(
        """INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number, correlation_id,
          authorization_token_id, manual_retry, created_at, updated_at) VALUES
          ('job_1', 'hh', 'rec', 'analysis', 'dispatch_pending', 1, 'corr', 'token', 1, ?, ?)""",
        (at, at),
    )
    assert connection.execute("SELECT analysis_status, version FROM recordings WHERE id = 'rec'").fetchone() == ('pending', 2)
    stale_review = connection.execute("UPDATE recordings SET draft_scene = 'stale' WHERE id = 'rec' AND version = 1 AND review_status = 'pending'")
    assert stale_review.rowcount == 0
    connection.execute("UPDATE async_jobs SET status = 'succeeded' WHERE id = 'job_1'")
    connection.execute("UPDATE recordings SET analysis_status = 'ready' WHERE id = 'rec'")
    with pytest.raises(sqlite3.IntegrityError, match='analysis_retry_state_changed'):
        connection.execute(
            """INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number, correlation_id,
              created_at, updated_at) VALUES ('job_2', 'hh', 'rec', 'analysis', 'dispatch_pending', 2, 'corr', ?, ?)""",
            (at, at),
        )
    assert connection.execute("SELECT COUNT(*) FROM async_jobs WHERE recording_id = 'rec'").fetchone()[0] == 1
    connection.execute("UPDATE recordings SET analysis_status = 'partial' WHERE id = 'rec'")
    with pytest.raises(sqlite3.IntegrityError, match='UNIQUE constraint failed'):
        connection.execute(
            """INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number,
              correlation_id, manual_retry, created_at, updated_at)
              VALUES ('job_3', 'hh', 'rec', 'analysis', 'dispatch_pending', 3, 'corr', 1, ?, ?)""",
            (at, at),
        )
    assert connection.execute("SELECT COUNT(*) FROM async_jobs WHERE recording_id = 'rec'").fetchone()[0] == 1
    connection.execute("DELETE FROM device_tokens WHERE id = 'token'")
    assert connection.execute("SELECT authorization_token_id FROM async_jobs WHERE id = 'job_1'").fetchone()[0] is None


def test_openai_usage_day_is_normalized_to_utc_and_word_day_must_match_created_at() -> None:
    connection = database()
    connection.execute('DROP TRIGGER activate_analysis_attempt')
    connection.execute(
        """INSERT INTO processing_attempts (
          id, household_id, recording_id, job_id, processing_kind, stage, attempt_number,
          status, retryable, correlation_id, started_at
        ) VALUES ('offset_attempt', 'hh', 'rec', 'job', 'analysis', 'transcription', 1, 'running', 0, 'corr', ?)""",
        ('2026-07-23T08:59:59+09:00',),
    )
    assert connection.execute("SELECT usage_day FROM openai_call_reservations WHERE attempt_id = 'offset_attempt'").fetchone()[0] == '2026-07-22'
    connection.execute(
        """INSERT INTO processing_attempts (
          id, household_id, recording_id, job_id, processing_kind, stage, attempt_number,
          status, retryable, correlation_id, started_at
        ) VALUES ('boundary_attempt', 'hh', 'rec', 'job_2', 'analysis', 'transcription', 2, 'running', 0, 'corr', ?)""",
        ('2026-07-23T09:00:00+09:00',),
    )
    assert connection.execute("SELECT usage_day FROM openai_call_reservations WHERE attempt_id = 'boundary_attempt'").fetchone()[0] == '2026-07-23'
    with pytest.raises(sqlite3.IntegrityError, match='openai_usage_day_mismatch'):
        connection.execute(
            "INSERT INTO openai_call_reservations (attempt_id, stage, usage_day, created_at) VALUES (?, 'word_extraction', ?, ?)",
            ('offset_attempt', '2026-07-23', '2026-07-23T08:59:59+09:00'),
        )
    connection.execute(
        "INSERT INTO openai_call_reservations (attempt_id, stage, usage_day, created_at) VALUES (?, 'word_extraction', ?, ?)",
        ('offset_attempt', '2026-07-22', '2026-07-23T08:59:59+09:00'),
    )
    with pytest.raises(sqlite3.IntegrityError, match='CHECK constraint failed'):
        connection.execute(
            "INSERT INTO openai_call_reservations (attempt_id, stage, usage_day, created_at) VALUES (?, 'transcription', ?, ?)",
            ('malformed_day', '20260723', '2026-07-23T00:00:00Z'),
        )
