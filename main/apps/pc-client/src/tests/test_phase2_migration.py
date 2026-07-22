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


def insert_recording(
    connection: sqlite3.Connection,
    recording_id: str,
    capture_id: str,
    *,
    received_at: str = '2026-07-21T00:00:00Z',
    duration_seconds: float = 15.0,
) -> None:
    """最小の必須列で録音1件を挿入する。"""
    connection.execute(
        """
        INSERT INTO recordings (
          id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
          captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds,
          post_roll_truncated, duration_seconds, upload_status, analysis_status, review_status,
          diary_status, image_status, created_at, updated_at
        ) VALUES (
          ?, 'household_demo', 'source_demo', ?, '2026-07-21T00:00:00Z',
          '2026-07-21T00:00:00Z', 'client_clock', 'Asia/Tokyo', ?, 10, 5,
          0, ?, 'reserved', 'pending', 'pending', 'not_started', 'not_requested',
          '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'
        )
        """,
        (recording_id, capture_id, received_at, duration_seconds),
    )


def seed_household(connection: sqlite3.Connection) -> None:
    """テスト用の世帯とPCソースを1組作成する。"""
    connection.executescript(
        """
        INSERT INTO households VALUES ('household_demo', '2026-07-21T00:00:00Z');
        INSERT INTO sources VALUES ('source_demo', 'household_demo', 'pc', '2026-07-21T00:00:00Z');
        """
    )


def test_initial_migration_creates_required_phase2_tables() -> None:
    """録音、非同期処理、利用量の永続化テーブルを作成し、外部キー検査を有効にする。"""
    connection = apply_migration()
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    table_names = {row[0] for row in rows}
    assert {'recordings', 'async_jobs', 'usage_counters', 'device_tokens'}.issubset(table_names)
    assert connection.execute('PRAGMA foreign_keys').fetchone() == (1,)


def test_initial_migration_enforces_recording_duration_limit() -> None:
    """20秒ちょうどを受理し、20秒超をduration制約で拒否する。"""
    connection = apply_migration()
    seed_household(connection)
    insert_recording(connection, 'rec_boundary', 'capture_boundary', duration_seconds=20.0)
    with pytest.raises(sqlite3.IntegrityError, match='duration_seconds'):
        insert_recording(connection, 'rec_demo', 'capture_demo', duration_seconds=20.1)


def test_initial_migration_enforces_capture_idempotency_key() -> None:
    """同一世帯・ソース・client_capture_idの二重挿入をユニーク制約で拒否する。"""
    connection = apply_migration()
    seed_household(connection)
    insert_recording(connection, 'rec_first', 'capture_same')
    with pytest.raises(sqlite3.IntegrityError, match='client_capture_id'):
        insert_recording(connection, 'rec_second', 'capture_same')


def test_initial_migration_enforces_single_nonterminal_analysis_job() -> None:
    """同一録音の非終端解析ジョブ二重作成を部分ユニークインデックスで拒否する。"""
    connection = apply_migration()
    seed_household(connection)
    insert_recording(connection, 'rec_job', 'capture_job')
    job_insert = """
        INSERT INTO async_jobs (
          id, household_id, recording_id, job_type, status, operation_number,
          correlation_id, created_at, updated_at
        ) VALUES (?, 'household_demo', 'rec_job', 'analysis', ?, ?, ?, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')
    """
    connection.execute(job_insert, ('job_active', 'running', 1, 'cor_1'))
    connection.execute(job_insert, ('job_done', 'failed', 2, 'cor_2'))
    with pytest.raises(sqlite3.IntegrityError, match=r'async_jobs\.recording_id, async_jobs\.job_type'):
        connection.execute(job_insert, ('job_duplicate', 'dispatch_pending', 3, 'cor_3'))


def test_daily_recording_limit_trigger_rejects_31st_and_resets_next_utc_day() -> None:
    """日次30件の31件目をUTC日単位で拒否し、翌日はリセットする。"""
    connection = apply_migration()
    seed_household(connection)
    for index in range(30):
        insert_recording(connection, f'rec_{index:02d}', f'capture_{index:02d}')
    with pytest.raises(sqlite3.IntegrityError, match='recording_daily_limit_reached'):
        insert_recording(connection, 'rec_30', 'capture_30')
    assert connection.execute("SELECT used_count FROM usage_counters WHERE usage_day = '2026-07-21'").fetchone() == (30,)
    insert_recording(connection, 'rec_next', 'capture_next', received_at='2026-07-22T00:00:00Z')
    assert connection.execute("SELECT used_count FROM usage_counters WHERE usage_day = '2026-07-22'").fetchone() == (1,)


def test_analysis_attempt_trigger_rejects_concurrent_running_attempt() -> None:
    """runningなactive attemptがある間は新しい解析attemptを拒否する。"""
    connection = apply_migration()
    seed_household(connection)
    insert_recording(connection, 'rec_active', 'capture_active')
    connection.execute("UPDATE recordings SET upload_status = 'ready' WHERE id = 'rec_active'")
    connection.execute(
        """
        INSERT INTO async_jobs (
          id, household_id, recording_id, job_type, status, operation_number,
          correlation_id, created_at, updated_at
        ) VALUES ('job_run', 'household_demo', 'rec_active', 'analysis', 'running', 1,
                  'cor_run', '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')
        """
    )
    attempt_insert = """
        INSERT INTO processing_attempts (
          id, household_id, recording_id, job_id, processing_kind, stage, attempt_number,
          status, retryable, correlation_id, started_at
        ) VALUES (?, 'household_demo', 'rec_active', 'job_run', 'analysis', 'mock_analysis',
                  ?, 'running', 0, 'cor_run', '2026-07-21T00:00:00Z')
    """
    connection.execute(attempt_insert, ('attempt_1', 1))
    assert connection.execute("SELECT analysis_status, active_attempt_id FROM recordings WHERE id = 'rec_active'").fetchone() == (
        'transcribing',
        'attempt_1',
    )
    with pytest.raises(sqlite3.IntegrityError, match='analysis_attempt_not_active'):
        connection.execute(attempt_insert, ('attempt_2', 2))


def test_delete_order_preserves_foreign_keys_and_recalculates_dictionary() -> None:
    """全子行の削除後も辞典の日時順と最小トゥームストーンを保つ。"""
    connection = apply_migration()
    connection.executescript(
        """
        INSERT INTO households VALUES ('household_demo', '2026-07-21T00:00:00Z');
        INSERT INTO sources VALUES ('source_demo', 'household_demo', 'sample', '2026-07-21T00:00:00Z');

        INSERT INTO recordings (
          id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
          captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds,
          post_roll_truncated, duration_seconds, audio_object_key, upload_status, analysis_status,
          review_status, diary_status, image_status, created_at, updated_at
        ) VALUES
          ('rec_delete', 'household_demo', 'source_demo', 'capture_delete', '2026-07-20T00:00:00Z',
           '2026-07-20T00:00:00Z', 'server_received', 'Asia/Tokyo', '2026-07-21T00:00:00Z',
           10, 5, 0, 15, 'recordings/rec_delete/audio.wav', 'ready', 'ready', 'deleting',
           'ready', 'ready', '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z'),
          ('rec_first', 'household_demo', 'source_demo', 'capture_first', '2026-07-20T00:00:00Z',
           '2026-07-20T00:00:00Z', 'server_received', 'Asia/Tokyo', '2026-07-21T00:01:00Z',
           10, 5, 0, 15, NULL, 'ready', 'ready', 'approved', 'ready', 'not_requested',
           '2026-07-20T00:01:00Z', '2026-07-21T00:01:00Z'),
          ('rec_second', 'household_demo', 'source_demo', 'capture_second', '2026-07-20T00:00:00Z',
           '2026-07-20T00:00:00Z', 'server_received', 'Asia/Tokyo', '2026-07-21T00:02:00Z',
           10, 5, 0, 15, NULL, 'ready', 'ready', 'approved', 'ready', 'not_requested',
           '2026-07-20T00:02:00Z', '2026-07-21T00:02:00Z');

        INSERT INTO transcripts VALUES (
          'rec_delete', 'raw', 'reviewed', 'ja', 'mock', 'v1',
          '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'
        );
        INSERT INTO word_candidates VALUES (
          'candidate_delete', 'rec_delete', 'ことば', 'ことば', 'noun', 1
        );
        INSERT INTO dictionary_words VALUES (
          'word_demo', 'household_demo', 'ことば', 'ことば', 'rec_delete',
          '2026-07-20T00:00:00Z', 3
        );
        INSERT INTO word_occurrences VALUES
          ('occ_delete', 'household_demo', 'rec_delete', 'word_demo', 'ことば',
           '2026-07-20T00:00:00Z', 'auto', 1, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'),
          ('occ_first', 'household_demo', 'rec_first', 'word_demo', 'ことば',
           '2026-07-20T00:01:00Z', 'auto', 0, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z'),
          ('occ_second', 'household_demo', 'rec_second', 'word_demo', 'ことば',
           '2026-07-20T00:02:00Z', 'auto', 0, '2026-07-19T00:00:00Z', '2026-07-19T00:00:00Z');
        INSERT INTO diary_entries VALUES (
          'diary_delete', 'rec_delete', 'scene', 'note', 'text', 'mock', 'v1', 1,
          '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'
        );
        INSERT INTO diary_images VALUES (
          'image_delete', 'diary_delete', 'recordings/rec_delete/image.webp', 1, 1,
          'mock', 'v1', '2026-07-21T00:00:00Z', NULL
        );
        INSERT INTO async_jobs (
          id, household_id, recording_id, job_type, status, operation_number,
          correlation_id, created_at, updated_at, started_at
        ) VALUES
          ('job_analysis', 'household_demo', 'rec_delete', 'analysis', 'failed', 1,
           'cor_analysis', '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z', NULL),
          ('job_delete', 'household_demo', 'rec_delete', 'delete', 'running', 1,
           'cor_delete', '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z',
           '2026-07-21T00:00:00Z');
        INSERT INTO processing_attempts VALUES (
          'attempt_delete', 'household_demo', 'rec_delete', 'job_delete', 'delete',
          'delete_media_and_data', 1, 'running', NULL, NULL, 1, 'cor_delete',
          '2026-07-21T00:00:00Z', NULL
        );
        INSERT INTO audit_events VALUES (
          'audit_capture', 'household_demo', 'rec_delete', 'captured_at_changed',
          'management_user', 'subject', '2026-07-19T00:00:00Z', '2026-07-20T00:00:00Z',
          'cor_audit', '2026-07-21T00:00:00Z'
        );
        """
    )

    connection.execute("DELETE FROM word_occurrences WHERE recording_id = 'rec_delete'")
    connection.execute(
        """
        WITH ranked AS (
          SELECT wo.id,
                 ROW_NUMBER() OVER (
                   PARTITION BY wo.dictionary_word_id
                   ORDER BY r.captured_at, r.created_at, wo.recording_id
                 ) AS rank
            FROM word_occurrences wo
            JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
           WHERE wo.dictionary_word_id = 'word_demo'
        )
        UPDATE word_occurrences
           SET is_first = CASE WHEN id IN (SELECT id FROM ranked WHERE rank = 1) THEN 1 ELSE 0 END
         WHERE dictionary_word_id = 'word_demo'
        """
    )
    connection.execute(
        """
        UPDATE dictionary_words
           SET occurrence_count = (
                 SELECT COUNT(*) FROM word_occurrences wo
                  WHERE wo.dictionary_word_id = dictionary_words.id
               ),
               first_recording_id = (
                 SELECT wo.recording_id FROM word_occurrences wo
                 JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                  WHERE wo.dictionary_word_id = dictionary_words.id
                  ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1
               ),
               first_spoken_at = (
                 SELECT wo.spoken_at FROM word_occurrences wo
                 JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                  WHERE wo.dictionary_word_id = dictionary_words.id
                  ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1
               )
         WHERE id = 'word_demo'
        """
    )
    connection.executescript(
        """
        DELETE FROM diary_images WHERE diary_entry_id = 'diary_delete';
        DELETE FROM diary_entries WHERE recording_id = 'rec_delete';
        DELETE FROM word_candidates WHERE recording_id = 'rec_delete';
        DELETE FROM transcripts WHERE recording_id = 'rec_delete';
        DELETE FROM audit_events WHERE recording_id = 'rec_delete';
        DELETE FROM processing_attempts WHERE recording_id = 'rec_delete';
        DELETE FROM async_jobs WHERE recording_id = 'rec_delete';
        INSERT INTO recording_tombstones VALUES (
          'rec_delete', 'household_demo', 'deleted', '2026-07-21T00:05:00Z'
        );
        DELETE FROM recordings
         WHERE id = 'rec_delete' AND household_id = 'household_demo' AND review_status = 'deleting';
        """
    )

    assert connection.execute('SELECT first_recording_id, first_spoken_at, occurrence_count FROM dictionary_words').fetchone() == (
        'rec_first',
        '2026-07-20T00:01:00Z',
        2,
    )
    assert connection.execute('SELECT recording_id, is_first FROM word_occurrences ORDER BY recording_id').fetchall() == [
        ('rec_first', 1),
        ('rec_second', 0),
    ]
    assert connection.execute("SELECT COUNT(*) FROM recordings WHERE id = 'rec_delete'").fetchone() == (0,)
    assert connection.execute('SELECT * FROM recording_tombstones').fetchone() == (
        'rec_delete',
        'household_demo',
        'deleted',
        '2026-07-21T00:05:00Z',
    )
    tombstone_columns = connection.execute('PRAGMA table_info(recording_tombstones)').fetchall()
    assert [column[1] for column in tombstone_columns] == [
        'recording_id',
        'household_id',
        'review_status',
        'deleted_at',
    ]
    assert connection.execute('PRAGMA foreign_key_check').fetchall() == []


def test_retention_query_skips_exhausted_rows_before_limit() -> None:
    """期限順の先頭が削除予算枯渇でも後続候補を選べる。"""
    connection = apply_migration()
    connection.executescript(
        """
        INSERT INTO households VALUES ('household_demo', '2026-07-21T00:00:00Z');
        INSERT INTO sources VALUES ('source_demo', 'household_demo', 'sample', '2026-07-21T00:00:00Z');
        """
    )
    recording_insert = """
        INSERT INTO recordings (
          id, household_id, source_id, client_capture_id, captured_at, captured_at_original,
          captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds,
          post_roll_truncated, duration_seconds, upload_status, analysis_status, review_status,
          diary_status, image_status, created_at, updated_at, retention_delete_after
        ) VALUES (?, 'household_demo', 'source_demo', ?, '2026-07-01T00:00:00Z',
                  '2026-07-01T00:00:00Z', 'server_received', 'Asia/Tokyo',
                  '2026-07-01T00:00:00Z', 10, 5, 0, 15, 'ready', 'ready', 'delete_failed',
                  'not_started', 'not_requested', ?, ?, '2026-07-02T00:00:00Z')
    """
    job_insert = """
        INSERT INTO async_jobs (
          id, household_id, recording_id, job_type, status, operation_number,
          correlation_id, created_at, updated_at, finished_at
        ) VALUES (?, 'household_demo', ?, 'delete', 'failed', ?, ?, ?, ?, ?)
    """
    for index in range(10):
        recording_id = f'rec_exhausted_{index:02d}'
        created_at = f'2026-07-01T00:{index:02d}:00Z'
        connection.execute(
            recording_insert,
            (recording_id, f'capture_exhausted_{index:02d}', created_at, created_at),
        )
        for operation in range(1, 4):
            job_id = f'job_{index:02d}_{operation}'
            connection.execute(
                job_insert,
                (
                    job_id,
                    recording_id,
                    operation,
                    f'cor_{index:02d}_{operation}',
                    created_at,
                    created_at,
                    created_at,
                ),
            )
    connection.execute(
        recording_insert,
        (
            'rec_eligible',
            'capture_eligible',
            '2026-07-01T00:59:00Z',
            '2026-07-01T00:59:00Z',
        ),
    )

    due = connection.execute(
        """
        SELECT id FROM recordings
         WHERE retention_delete_after IS NOT NULL AND retention_delete_after <= ? AND deleted_at IS NULL
           AND review_status IN ('pending', 'approved', 'delete_failed')
           AND (
             (SELECT COUNT(*) FROM processing_attempts
               WHERE recording_id = recordings.id AND processing_kind = 'delete') +
             (SELECT COUNT(*) FROM async_jobs j
               WHERE j.recording_id = recordings.id AND j.job_type = 'delete' AND j.status = 'failed'
                 AND NOT EXISTS (
                   SELECT 1 FROM processing_attempts pa
                    WHERE pa.job_id = j.id AND pa.processing_kind = 'delete'
                 ))
           ) < ?
         ORDER BY retention_delete_after ASC, created_at ASC, id ASC LIMIT ?
        """,
        ('2026-07-21T00:00:00Z', 3, 10),
    ).fetchall()
    assert due == [('rec_eligible',)]


def test_phase3_dictionary_reindex_keeps_chronology_and_nonapproved_history() -> None:
    """承認済みだけを日時・登録順で再集計し、削除待ち行の発話日時は変更しない。"""
    connection = apply_migration()
    seed_household(connection)
    for recording_id, capture_id in (
        ('rec_same_a', 'capture_same_a'),
        ('rec_same_b', 'capture_same_b'),
        ('rec_same_c', 'capture_same_c'),
        ('rec_deleting', 'capture_deleting'),
    ):
        insert_recording(connection, recording_id, capture_id)
    connection.executescript(
        """
        UPDATE recordings SET review_status = 'approved', captured_at = '2020-01-02T00:00:00.000Z',
          created_at = '2026-07-21T00:00:01.000Z' WHERE id = 'rec_same_a';
        UPDATE recordings SET review_status = 'approved', captured_at = '2020-01-02T00:00:00.000Z',
          created_at = '2026-07-21T00:00:02.000Z' WHERE id = 'rec_same_b';
        UPDATE recordings SET review_status = 'approved', captured_at = '2020-01-02T00:00:00.000Z',
          created_at = '2026-07-21T00:00:02.000Z' WHERE id = 'rec_same_c';
        UPDATE recordings SET review_status = 'deleting', captured_at = '2019-01-01T00:00:00.000Z' WHERE id = 'rec_deleting';
        INSERT INTO dictionary_words VALUES ('word_phase3', 'household_demo', 'りんご', 'りんご', NULL, NULL, 0);
        INSERT INTO word_occurrences VALUES
          ('occ_a', 'household_demo', 'rec_same_a', 'word_phase3', 'りんご', 'old-a', 'auto', 0, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'),
          ('occ_b', 'household_demo', 'rec_same_b', 'word_phase3', 'りんご', 'old-b',
           'force_not_new', 0, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'),
          ('occ_c', 'household_demo', 'rec_same_c', 'word_phase3', 'りんご', 'old-c',
           'force_new', 0, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z'),
          ('occ_deleting', 'household_demo', 'rec_deleting', 'word_phase3', 'りんご',
           'preserve-me', 'auto', 1, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z');
        """
    )
    connection.execute(
        """
        WITH ranked AS (
          SELECT wo.id,
                 ROW_NUMBER() OVER (
                   PARTITION BY wo.dictionary_word_id
                   ORDER BY r.captured_at, r.created_at, wo.recording_id
                 ) AS rank,
                 r.captured_at AS captured_at
            FROM word_occurrences wo
            JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
           WHERE wo.dictionary_word_id IN (
             SELECT id FROM dictionary_words WHERE household_id = ? AND normalized IN (?)
           ) AND r.review_status = 'approved'
        )
        UPDATE word_occurrences
           SET is_first = CASE WHEN id IN (SELECT id FROM ranked WHERE rank = 1) THEN 1 ELSE 0 END,
               spoken_at = (SELECT captured_at FROM ranked WHERE ranked.id = word_occurrences.id)
         WHERE dictionary_word_id IN (
           SELECT id FROM dictionary_words WHERE household_id = ? AND normalized IN (?)
         )
           AND EXISTS (
             SELECT 1 FROM recordings approved
              WHERE approved.id = word_occurrences.recording_id
                AND approved.household_id = word_occurrences.household_id
                AND approved.review_status = 'approved'
           )
        """,
        ('household_demo', 'りんご', 'household_demo', 'りんご'),
    )
    connection.execute(
        """
        UPDATE dictionary_words
           SET occurrence_count = (
                 SELECT COUNT(*) FROM word_occurrences wo
                  JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                 WHERE wo.dictionary_word_id = dictionary_words.id AND r.review_status = 'approved'
               ),
               first_recording_id = (
                 SELECT wo.recording_id FROM word_occurrences wo
                  JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                 WHERE wo.dictionary_word_id = dictionary_words.id AND r.review_status = 'approved'
                 ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1
               ),
               first_spoken_at = (
                 SELECT r.captured_at FROM word_occurrences wo
                  JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                 WHERE wo.dictionary_word_id = dictionary_words.id AND r.review_status = 'approved'
                 ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1
               )
         WHERE id = 'word_phase3'
        """
    )
    assert connection.execute('SELECT first_recording_id, first_spoken_at, occurrence_count FROM dictionary_words').fetchone() == (
        'rec_same_a',
        '2020-01-02T00:00:00.000Z',
        3,
    )
    assert connection.execute("SELECT id, is_first, spoken_at FROM word_occurrences WHERE id != 'occ_deleting' ORDER BY id").fetchall() == [
        ('occ_a', 1, '2020-01-02T00:00:00.000Z'),
        ('occ_b', 0, '2020-01-02T00:00:00.000Z'),
        ('occ_c', 0, '2020-01-02T00:00:00.000Z'),
    ]
    assert connection.execute("SELECT spoken_at FROM word_occurrences WHERE id = 'occ_deleting'").fetchone() == ('preserve-me',)


def test_phase3_version_conflict_sentinel_aborts_whole_batch() -> None:
    """楽観ロック不成立時は番兵のNOT NULL違反でバッチ全体をロールバックする。"""
    connection = apply_migration()
    seed_household(connection)
    insert_recording(connection, 'rec_lock', 'capture_lock')
    connection.commit()

    sentinel = """
        INSERT INTO recording_tombstones (recording_id, household_id, review_status, deleted_at)
        SELECT NULL, NULL, NULL, NULL WHERE (SELECT changes()) = 0
    """
    connection.execute('BEGIN')
    connection.execute("UPDATE recordings SET version = version + 1 WHERE id = 'rec_lock' AND version = 99")
    with pytest.raises(sqlite3.IntegrityError, match='recording_tombstones'):
        connection.execute(sentinel)
    connection.rollback()
    assert connection.execute("SELECT version, draft_scene FROM recordings WHERE id = 'rec_lock'").fetchone() == (1, None)
    assert connection.execute('SELECT COUNT(*) FROM recording_tombstones').fetchone() == (0,)

    connection.execute('BEGIN')
    connection.execute("UPDATE recordings SET version = version + 1 WHERE id = 'rec_lock' AND version = 1")
    connection.execute(sentinel)
    connection.execute("UPDATE recordings SET draft_scene = 'winner-write' WHERE id = 'rec_lock' AND version = 2")
    connection.commit()
    assert connection.execute("SELECT version, draft_scene FROM recordings WHERE id = 'rec_lock'").fetchone() == (2, 'winner-write')


def test_dictionary_word_delete_blocked_while_occurrence_references_it() -> None:
    """発話参照が残る辞典単語の削除はFKで拒否され、参照消滅後にだけ削除できる。"""
    connection = apply_migration()
    seed_household(connection)
    insert_recording(connection, 'rec_ref', 'capture_ref')
    connection.executescript(
        """
        UPDATE recordings SET review_status = 'deleting' WHERE id = 'rec_ref';
        INSERT INTO dictionary_words VALUES ('word_ref', 'household_demo', 'りんご', 'りんご', NULL, NULL, 0);
        INSERT INTO word_occurrences VALUES
          ('occ_ref', 'household_demo', 'rec_ref', 'word_ref', 'りんご', '2026-07-21T00:00:00Z',
           'auto', 0, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z');
        """
    )
    with pytest.raises(sqlite3.IntegrityError, match='FOREIGN KEY'):
        connection.execute("DELETE FROM dictionary_words WHERE id = 'word_ref' AND occurrence_count = 0")
    guarded_delete = """
        DELETE FROM dictionary_words WHERE id = 'word_ref' AND occurrence_count = 0
          AND NOT EXISTS (SELECT 1 FROM word_occurrences wo WHERE wo.dictionary_word_id = dictionary_words.id)
    """
    connection.execute(guarded_delete)
    assert connection.execute('SELECT COUNT(*) FROM dictionary_words').fetchone() == (1,)
    connection.execute("DELETE FROM word_occurrences WHERE id = 'occ_ref'")
    connection.execute(guarded_delete)
    assert connection.execute('SELECT COUNT(*) FROM dictionary_words').fetchone() == (0,)


def test_phase3_schema_rejects_cross_household_and_duplicate_dictionary_words() -> None:
    """Phase 3が依存する外部キー、NOT NULL、世帯内正規化一意性を実行する。"""
    connection = apply_migration()
    seed_household(connection)
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute(
            'INSERT INTO diary_entries (id, recording_id, version, created_at, updated_at) '
            "VALUES ('diary_missing', 'rec_missing', 1, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')"
        )
    connection.execute(
        'INSERT INTO dictionary_words (id, household_id, normalized, display_name, occurrence_count) '
        "VALUES ('word_one', 'household_demo', 'りんご', 'りんご', 0)"
    )
    with pytest.raises(sqlite3.IntegrityError, match=r'dictionary_words\.household_id, dictionary_words\.normalized'):
        connection.execute(
            'INSERT INTO dictionary_words (id, household_id, normalized, display_name, occurrence_count) '
            "VALUES ('word_two', 'household_demo', 'りんご', '別表記', 0)"
        )
