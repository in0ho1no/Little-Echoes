import { WorkflowEntrypoint } from 'cloudflare:workers';

import type { Env, WorkflowParams } from './types';

export const RETENTION_BATCH_SIZE = 10;
export const RETENTION_RECONCILE_BATCH_SIZE = 5;
const DELETE_BUDGET_LIMIT = 3;
const DISPATCH_LEASE_MILLISECONDS = 5 * 60 * 1000;
const WORKFLOW_STALE_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface DeleteTarget {
  id: string;
  household_id: string;
  version: number;
  review_status: string;
}

export interface DeleteReservation {
  asyncJobId: string | null;
  status: 'dispatched' | 'dispatch_pending' | 'failed' | 'unknown' | 'version_conflict' | 'attempt_limit';
}

interface DeleteJobRow {
  id: string;
  household_id: string;
  recording_id: string;
  correlation_id: string;
  status: string;
  audio_object_key: string | null;
}

interface ExistingJobRow {
  id: string;
  status: string;
  dispatch_reconcile_count: number;
  dispatch_lease_until: string | null;
  last_error_code: string | null;
  created_at: string;
  started_at: string | null;
}

function newDeleteJobId(): string {
  return `job_${crypto.randomUUID().replaceAll('-', '')}`;
}

function newAttemptId(): string {
  return `attempt_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function activeDeleteJob(env: Env, recordingId: string): Promise<ExistingJobRow | null> {
  return env.DB.prepare(
    `SELECT id, status, dispatch_reconcile_count, dispatch_lease_until, last_error_code, created_at, started_at FROM async_jobs
      WHERE recording_id = ? AND job_type = 'delete' AND status IN ('dispatch_pending', 'dispatched', 'running')
      ORDER BY operation_number DESC LIMIT 1`,
  )
    .bind(recordingId)
    .first<ExistingJobRow>();
}

async function deleteBudgetUsed(env: Env, recordingId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM processing_attempts WHERE recording_id = ? AND processing_kind = 'delete') +
       (SELECT COUNT(*) FROM async_jobs j
         WHERE j.recording_id = ? AND j.job_type = 'delete' AND j.status = 'failed'
           AND NOT EXISTS (SELECT 1 FROM processing_attempts pa WHERE pa.job_id = j.id AND pa.processing_kind = 'delete')) AS used`,
  )
    .bind(recordingId, recordingId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

async function failDeleteDispatch(env: Env, asyncJobId: string, errorCode: string): Promise<boolean> {
  const failedAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE async_jobs SET status = 'failed', last_error_code = ?, finished_at = ?, dispatch_lease_until = NULL, updated_at = ?
        WHERE id = ? AND job_type = 'delete' AND status IN ('dispatch_pending', 'dispatched', 'running')`,
    ).bind(errorCode, failedAt, failedAt, asyncJobId),
    env.DB.prepare(
      `UPDATE recordings SET review_status = 'delete_failed', updated_at = ?
        WHERE id = (SELECT recording_id FROM async_jobs WHERE id = ?) AND review_status = 'deleting'
          AND EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status = 'failed')`,
    ).bind(failedAt, asyncJobId, asyncJobId),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function ensureDeleteWorkflow(env: Env, asyncJobId: string): Promise<DeleteReservation['status']> {
  const before = await env.DB.prepare(
    `SELECT id, status, dispatch_reconcile_count, dispatch_lease_until, last_error_code, created_at, started_at FROM async_jobs WHERE id = ? AND job_type = 'delete'`,
  )
    .bind(asyncJobId)
    .first<ExistingJobRow>();
  if (!before) return 'failed';
  if (before.status === 'failed') return 'failed';
  if (before.dispatch_reconcile_count >= DELETE_BUDGET_LIMIT && before.last_error_code === 'DELETE_WORKFLOW_DISPATCH_QUARANTINED') return 'unknown';

  const now = new Date();
  const nowText = now.toISOString();
  const leaseUntil = new Date(now.getTime() + DISPATCH_LEASE_MILLISECONDS).toISOString();
  const mayDispatch = before.dispatch_reconcile_count < DELETE_BUDGET_LIMIT;
  const claim = mayDispatch
    ? await env.DB.prepare(
        `UPDATE async_jobs
            SET dispatch_reconcile_count = dispatch_reconcile_count + 1, dispatch_lease_until = ?, updated_at = ?
          WHERE id = ? AND job_type = 'delete' AND status IN ('dispatch_pending', 'dispatched', 'running')
            AND dispatch_reconcile_count < ? AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)`,
      )
        .bind(leaseUntil, nowText, asyncJobId, DELETE_BUDGET_LIMIT, nowText)
        .run()
    : await env.DB.prepare(
        `UPDATE async_jobs SET dispatch_lease_until = ?, updated_at = ?
          WHERE id = ? AND job_type = 'delete' AND status IN ('dispatch_pending', 'dispatched', 'running')
            AND dispatch_reconcile_count >= ? AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)`,
      )
        .bind(leaseUntil, nowText, asyncJobId, DELETE_BUDGET_LIMIT, nowText)
        .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const current = await env.DB.prepare('SELECT status FROM async_jobs WHERE id = ? AND job_type = ?').bind(asyncJobId, 'delete').first<{ status: string }>();
    if (current?.status === 'failed') return 'failed';
    return current?.status === 'dispatch_pending' ? 'dispatch_pending' : 'dispatched';
  }

  const claimed = await env.DB.prepare(
    'SELECT status, dispatch_reconcile_count, last_error_code, created_at, started_at FROM async_jobs WHERE id = ? AND job_type = ?',
  )
    .bind(asyncJobId, 'delete')
    .first<Pick<ExistingJobRow, 'status' | 'dispatch_reconcile_count' | 'last_error_code' | 'created_at' | 'started_at'>>();
  try {
    if (mayDispatch && claimed?.status === 'dispatch_pending') {
      await env.DELETE_WORKFLOW.create({ id: asyncJobId, params: { async_job_id: asyncJobId } });
      await env.DB.prepare(
        `UPDATE async_jobs
            SET status = 'dispatched', workflow_instance_id = ?, last_error_code = NULL,
                dispatch_reconcile_count = 0, dispatch_lease_until = NULL, updated_at = ?
          WHERE id = ? AND job_type = 'delete' AND status = 'dispatch_pending'`,
      )
        .bind(asyncJobId, new Date().toISOString(), asyncJobId)
        .run();
      return 'dispatched';
    }
  } catch {
    // createの結果が不明でも、決定的な同一IDをgetで照合する。
  }

  try {
    const instance = await env.DELETE_WORKFLOW.get(asyncJobId);
    const observed = await instance.status();
    const status = typeof observed?.status === 'string' ? observed.status : 'unknown';
    if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(status)) {
      const activeSince = claimed?.started_at ?? claimed?.created_at ?? before.started_at ?? before.created_at;
      const activeSinceMilliseconds = Date.parse(activeSince);
      if (Number.isFinite(activeSinceMilliseconds) && now.getTime() - activeSinceMilliseconds >= WORKFLOW_STALE_MILLISECONDS) {
        try {
          await instance.terminate();
        } catch {
          await env.DB.prepare(
            `UPDATE async_jobs SET last_error_code = ?, updated_at = ?
              WHERE id = ? AND job_type = 'delete' AND status IN ('dispatch_pending', 'dispatched', 'running')`,
          )
            .bind(
              (claimed?.dispatch_reconcile_count ?? DELETE_BUDGET_LIMIT) >= DELETE_BUDGET_LIMIT
                ? 'DELETE_WORKFLOW_DISPATCH_QUARANTINED'
                : 'DELETE_WORKFLOW_TERMINATION_UNKNOWN',
              new Date().toISOString(),
              asyncJobId,
            )
            .run()
            .catch(() => undefined);
          return 'unknown';
        }
        return (await failDeleteDispatch(env, asyncJobId, 'DELETE_WORKFLOW_STALE')) ? 'failed' : 'dispatched';
      }
      await env.DB.prepare(
        `UPDATE async_jobs
            SET status = CASE WHEN status = 'dispatch_pending' THEN 'dispatched' ELSE status END,
                workflow_instance_id = ?, last_error_code = NULL, dispatch_reconcile_count = 0,
                dispatch_lease_until = NULL, updated_at = ?
          WHERE id = ? AND job_type = 'delete' AND status IN ('dispatch_pending', 'dispatched', 'running')`,
      )
        .bind(asyncJobId, new Date().toISOString(), asyncJobId)
        .run();
      return 'dispatched';
    }
    if (status === 'complete') {
      const tombstone = await env.DB.prepare(
        `SELECT t.recording_id FROM recording_tombstones t
          WHERE t.recording_id = (SELECT recording_id FROM async_jobs WHERE id = ?)`,
      )
        .bind(asyncJobId)
        .first<{ recording_id: string }>();
      if (tombstone) return 'dispatched';
      return (await failDeleteDispatch(env, asyncJobId, 'DELETE_WORKFLOW_COMPLETED_WITHOUT_DELETE')) ? 'failed' : 'dispatched';
    }
    if (['errored', 'terminated'].includes(status)) {
      return (await failDeleteDispatch(env, asyncJobId, 'DELETE_WORKFLOW_DISPATCH_FAILED')) ? 'failed' : 'dispatched';
    }
  } catch {
    // 状態不明時は同じIDだけを次回の低頻度スケジュールで再照合する。
  }

  await env.DB.prepare(
    `UPDATE async_jobs
        SET last_error_code = ?, dispatch_lease_until = NULL, updated_at = ?
      WHERE id = ? AND job_type = 'delete' AND status IN ('dispatch_pending', 'dispatched', 'running')`,
  )
    .bind(
      (claimed?.dispatch_reconcile_count ?? DELETE_BUDGET_LIMIT) >= DELETE_BUDGET_LIMIT
        ? 'DELETE_WORKFLOW_DISPATCH_QUARANTINED'
        : 'DELETE_WORKFLOW_DISPATCH_UNKNOWN',
      new Date().toISOString(),
      asyncJobId,
    )
    .run()
    .catch(() => undefined);
  return 'unknown';
}

export async function reserveDeleteJob(
  env: Env,
  target: DeleteTarget,
  expectedVersion: number,
  _actorType: 'management_user' | 'system',
  _actorId: string,
  correlationId: string,
): Promise<DeleteReservation> {
  const current = await activeDeleteJob(env, target.id);
  if (target.review_status === 'deleting' && current) {
    const status = current.status === 'dispatch_pending' ? await ensureDeleteWorkflow(env, current.id) : 'dispatched';
    return { asyncJobId: current.id, status };
  }
  if (!['pending', 'approved', 'delete_failed'].includes(target.review_status) || target.version !== expectedVersion) {
    return { asyncJobId: null, status: 'version_conflict' };
  }
  if ((await deleteBudgetUsed(env, target.id)) >= DELETE_BUDGET_LIMIT) return { asyncJobId: null, status: 'attempt_limit' };

  const asyncJobId = newDeleteJobId();
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE recordings SET review_status = 'deleting', version = version + 1, active_attempt_id = NULL, updated_at = ?
        WHERE id = ? AND household_id = ? AND version = ? AND review_status IN ('pending', 'approved', 'delete_failed')
          AND (
            (SELECT COUNT(*) FROM processing_attempts WHERE recording_id = ? AND processing_kind = 'delete') +
            (SELECT COUNT(*) FROM async_jobs j WHERE j.recording_id = ? AND j.job_type = 'delete' AND j.status = 'failed'
              AND NOT EXISTS (SELECT 1 FROM processing_attempts pa WHERE pa.job_id = j.id AND pa.processing_kind = 'delete'))
          ) < ?`,
    ).bind(now, target.id, target.household_id, expectedVersion, target.id, target.id, DELETE_BUDGET_LIMIT),
    env.DB.prepare(
      `UPDATE processing_attempts
          SET status = 'failed', error_code = 'DELETE_REQUESTED', retryable = 0, finished_at = ?
        WHERE recording_id = ? AND processing_kind IN ('analysis', 'diary', 'image') AND status = 'running'
          AND EXISTS (SELECT 1 FROM recordings WHERE id = ? AND household_id = ? AND review_status = 'deleting' AND version = ?)`,
    ).bind(now, target.id, target.id, target.household_id, expectedVersion + 1),
    env.DB.prepare(
      `UPDATE async_jobs SET status = 'failed', last_error_code = 'DELETE_REQUESTED', finished_at = ?, updated_at = ?
        WHERE recording_id = ? AND job_type IN ('analysis', 'diary', 'image') AND status IN ('dispatch_pending', 'dispatched', 'running')
          AND EXISTS (SELECT 1 FROM recordings WHERE id = ? AND household_id = ? AND review_status = 'deleting' AND version = ?)`,
    ).bind(now, now, target.id, target.id, target.household_id, expectedVersion + 1),
    env.DB.prepare(
      `INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number, correlation_id, created_at, updated_at)
       SELECT ?, ?, ?, 'delete', 'dispatch_pending', COALESCE(MAX(operation_number) + 1, 1), ?, ?, ?
         FROM async_jobs
         WHERE recording_id = ? AND job_type = 'delete'
       HAVING EXISTS (SELECT 1 FROM recordings WHERE id = ? AND household_id = ? AND review_status = 'deleting' AND version = ?)
          AND NOT EXISTS (
         SELECT 1 FROM async_jobs active WHERE active.recording_id = ? AND active.job_type = 'delete'
           AND active.status IN ('dispatch_pending', 'dispatched', 'running')
       )`,
    ).bind(asyncJobId, target.household_id, target.id, correlationId, now, now, target.id, target.id, target.household_id, expectedVersion + 1, target.id),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const raced = await activeDeleteJob(env, target.id);
    return raced ? { asyncJobId: raced.id, status: raced.status === 'dispatch_pending' ? await ensureDeleteWorkflow(env, raced.id) : 'dispatched' } : { asyncJobId: null, status: 'version_conflict' };
  }
  if ((results[3]?.meta.changes ?? 0) !== 1) {
    const raced = await activeDeleteJob(env, target.id);
    if (raced) return { asyncJobId: raced.id, status: raced.status === 'dispatch_pending' ? await ensureDeleteWorkflow(env, raced.id) : 'dispatched' };
    await env.DB.prepare(`UPDATE recordings SET review_status = 'delete_failed', updated_at = ? WHERE id = ? AND review_status = 'deleting'`).bind(now, target.id).run();
    return { asyncJobId: null, status: 'failed' };
  }
  return { asyncJobId, status: await ensureDeleteWorkflow(env, asyncJobId) };
}

async function deleteDataInD1(env: Env, job: DeleteJobRow, attemptId: string): Promise<boolean> {
  const wordIds = (
    await env.DB.prepare('SELECT DISTINCT dictionary_word_id FROM word_occurrences WHERE recording_id = ?').bind(job.recording_id).all<{ dictionary_word_id: string }>()
  ).results.map((row) => row.dictionary_word_id);
  const imageRows = (
    await env.DB.prepare(
      `SELECT image_object_key FROM diary_images WHERE diary_entry_id IN (SELECT id FROM diary_entries WHERE recording_id = ?)`,
    )
      .bind(job.recording_id)
      .all<{ image_object_key: string }>()
  ).results;
  const objectKeys = [job.audio_object_key, ...imageRows.map((row) => row.image_object_key)].filter((key): key is string => Boolean(key));
  if (objectKeys.length > 0) await env.PRIVATE_MEDIA.delete(objectKeys);

  const now = new Date().toISOString();
  const wordPlaceholders = wordIds.map(() => '?').join(',');
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM word_occurrences WHERE recording_id = ?').bind(job.recording_id),
  ];
  if (wordIds.length > 0) {
    statements.push(
      env.DB.prepare(
        `WITH ranked AS (
           SELECT wo.id, ROW_NUMBER() OVER (PARTITION BY wo.dictionary_word_id ORDER BY r.captured_at, r.created_at, wo.recording_id) AS rank
             FROM word_occurrences wo JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
            WHERE wo.dictionary_word_id IN (${wordPlaceholders})
         )
         UPDATE word_occurrences SET is_first = CASE WHEN id IN (SELECT id FROM ranked WHERE rank = 1) THEN 1 ELSE 0 END
          WHERE dictionary_word_id IN (${wordPlaceholders})`,
      ).bind(...wordIds, ...wordIds),
      env.DB.prepare(
        `UPDATE dictionary_words
            SET occurrence_count = (SELECT COUNT(*) FROM word_occurrences wo WHERE wo.dictionary_word_id = dictionary_words.id),
                first_recording_id = (SELECT wo.recording_id FROM word_occurrences wo JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id WHERE wo.dictionary_word_id = dictionary_words.id ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1),
                first_spoken_at = (SELECT wo.spoken_at FROM word_occurrences wo JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id WHERE wo.dictionary_word_id = dictionary_words.id ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1)
          WHERE id IN (${wordPlaceholders})`,
      ).bind(...wordIds),
      env.DB.prepare(`DELETE FROM dictionary_words WHERE id IN (${wordPlaceholders}) AND occurrence_count = 0`).bind(...wordIds),
    );
  }
  statements.push(
    env.DB.prepare('DELETE FROM diary_images WHERE diary_entry_id IN (SELECT id FROM diary_entries WHERE recording_id = ?)').bind(job.recording_id),
    env.DB.prepare('DELETE FROM diary_entries WHERE recording_id = ?').bind(job.recording_id),
    env.DB.prepare('DELETE FROM word_candidates WHERE recording_id = ?').bind(job.recording_id),
    env.DB.prepare('DELETE FROM transcripts WHERE recording_id = ?').bind(job.recording_id),
    env.DB.prepare('DELETE FROM audit_events WHERE recording_id = ?').bind(job.recording_id),
    env.DB.prepare(`UPDATE processing_attempts SET status = 'succeeded', finished_at = ? WHERE id = ? AND status = 'running'`).bind(now, attemptId),
    env.DB.prepare('DELETE FROM processing_attempts WHERE recording_id = ?').bind(job.recording_id),
    env.DB.prepare('DELETE FROM async_jobs WHERE recording_id = ?').bind(job.recording_id),
    env.DB.prepare(
      `INSERT INTO recording_tombstones (recording_id, household_id, review_status, deleted_at)
       VALUES (?, ?, 'deleted', ?) ON CONFLICT(recording_id) DO NOTHING`,
    ).bind(job.recording_id, job.household_id, now),
    env.DB.prepare(`DELETE FROM recordings WHERE id = ? AND household_id = ? AND review_status = 'deleting'`).bind(job.recording_id, job.household_id),
  );
  try {
    const results = await env.DB.batch(statements);
    return (results.at(-1)?.meta.changes ?? 0) === 1;
  } catch {
    const tombstone = await env.DB.prepare('SELECT recording_id FROM recording_tombstones WHERE recording_id = ? AND household_id = ?')
      .bind(job.recording_id, job.household_id)
      .first<{ recording_id: string }>();
    if (tombstone) return true;
    throw new Error('delete database commit is unresolved');
  }
}

export async function runDeleteWorkflow(
  env: Env,
  asyncJobId: string,
  runStep: (name: string, operation: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const tombstone = await env.DB.prepare('SELECT recording_id FROM recording_tombstones WHERE recording_id = (SELECT recording_id FROM async_jobs WHERE id = ?)')
    .bind(asyncJobId)
    .first<{ recording_id: string }>();
  if (tombstone) return;
  const job = await env.DB.prepare(
    `SELECT j.id, j.household_id, j.recording_id, j.correlation_id, j.status, r.audio_object_key
       FROM async_jobs j JOIN recordings r ON r.id = j.recording_id AND r.household_id = j.household_id
      WHERE j.id = ? AND j.job_type = 'delete'`,
  )
    .bind(asyncJobId)
    .first<DeleteJobRow>();
  if (!job || ['succeeded', 'failed'].includes(job.status)) return;
  const started = await env.DB.prepare(
    `UPDATE async_jobs
        SET status = 'running', started_at = COALESCE(started_at, ?), dispatch_reconcile_count = 0,
            dispatch_lease_until = NULL, updated_at = ?
      WHERE id = ? AND status IN ('dispatch_pending', 'dispatched')`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), job.id)
    .run();
  if ((started.meta.changes ?? 0) !== 1 && job.status !== 'running') return;
  try {
    await runStep('delete-recording', async () => {
      const attemptId = newAttemptId();
      const startedAt = new Date().toISOString();
      const reservation = await env.DB.prepare(
        `INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind, stage, attempt_number, status, retryable, correlation_id, started_at)
         SELECT ?, ?, ?, ?, 'delete', 'delete_media_and_data', COALESCE(MAX(attempt_number), 0) + 1, 'running', 1, ?, ?
           FROM processing_attempts WHERE recording_id = ? AND processing_kind = 'delete'
          HAVING COUNT(*) + (
            SELECT COUNT(*) FROM async_jobs failed_job
             WHERE failed_job.recording_id = ? AND failed_job.job_type = 'delete' AND failed_job.status = 'failed'
               AND NOT EXISTS (SELECT 1 FROM processing_attempts prior WHERE prior.job_id = failed_job.id AND prior.processing_kind = 'delete')
          ) < ?`,
      )
        .bind(attemptId, job.household_id, job.recording_id, job.id, job.correlation_id, startedAt, job.recording_id, job.recording_id, DELETE_BUDGET_LIMIT)
        .run();
      // トリガーがattempt挿入へ波及してもmeta.changesの厳密一致に依存しないよう、未挿入(0)だけを失敗とする。
      if ((reservation.meta.changes ?? 0) === 0) throw new Error('delete attempt limit reached');
      try {
        const removed = await deleteDataInD1(env, job, attemptId);
        if (!removed) throw new Error('delete did not remove recording');
      } catch (error) {
        await env.DB.prepare(
          `UPDATE processing_attempts SET status = 'failed', error_code = 'DELETE_RETRYABLE_FAILURE', retryable = 1, finished_at = ?
            WHERE id = ? AND status = 'running'`,
        )
          .bind(new Date().toISOString(), attemptId)
          .run()
          .catch(() => undefined);
        throw error;
      }
    });
  } catch {
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE async_jobs SET status = 'failed', last_error_code = 'DELETE_FAILED', finished_at = ?, updated_at = ? WHERE id = ?`).bind(failedAt, failedAt, job.id),
      env.DB.prepare(`UPDATE recordings SET review_status = 'delete_failed', updated_at = ? WHERE id = ? AND household_id = ? AND review_status = 'deleting'`).bind(
        failedAt,
        job.recording_id,
        job.household_id,
      ),
    ]);
  }
}

export async function scheduleRetentionCleanup(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const reconciling = await env.DB.prepare(
    `SELECT r.id, r.household_id, r.version, r.review_status, j.id AS async_job_id
       FROM recordings r JOIN async_jobs j ON j.recording_id = r.id AND j.household_id = r.household_id
      WHERE r.review_status = 'deleting' AND j.job_type = 'delete' AND j.status IN ('dispatch_pending', 'dispatched', 'running')
        AND NOT (j.dispatch_reconcile_count >= ? AND j.last_error_code = 'DELETE_WORKFLOW_DISPATCH_QUARANTINED')
      ORDER BY j.updated_at ASC, j.id ASC LIMIT ?`,
  )
    .bind(DELETE_BUDGET_LIMIT, RETENTION_RECONCILE_BATCH_SIZE)
    .all<DeleteTarget & { async_job_id: string }>();
  for (const target of reconciling.results) {
    try {
      await ensureDeleteWorkflow(env, target.async_job_id);
    } catch {
      // 次回の低頻度スケジュールで同じIDだけを再確認する。
    }
  }
  const remaining = RETENTION_BATCH_SIZE - reconciling.results.length;
  if (remaining <= 0) return;
  const reconciledRecordingIds = reconciling.results.map((target) => target.id);
  const excludedPlaceholders = reconciledRecordingIds.map(() => '?').join(',');
  const excludedClause = reconciledRecordingIds.length > 0 ? `AND id NOT IN (${excludedPlaceholders})` : '';
  const due = await env.DB.prepare(
    `SELECT id, household_id, version, review_status FROM recordings
      WHERE retention_delete_after IS NOT NULL AND retention_delete_after <= ? AND deleted_at IS NULL
        AND review_status IN ('pending', 'approved', 'delete_failed')
        AND (
          (SELECT COUNT(*) FROM processing_attempts WHERE recording_id = recordings.id AND processing_kind = 'delete') +
          (SELECT COUNT(*) FROM async_jobs j WHERE j.recording_id = recordings.id AND j.job_type = 'delete' AND j.status = 'failed'
            AND NOT EXISTS (SELECT 1 FROM processing_attempts pa WHERE pa.job_id = j.id AND pa.processing_kind = 'delete'))
        ) < ?
        ${excludedClause}
      ORDER BY retention_delete_after ASC, created_at ASC, id ASC LIMIT ?`,
  )
    .bind(now, DELETE_BUDGET_LIMIT, ...reconciledRecordingIds, remaining)
    .all<DeleteTarget>();
  for (const target of due.results) {
    try {
      await reserveDeleteJob(env, target, target.version, 'system', 'retention_scheduler', `cor_${crypto.randomUUID().replaceAll('-', '')}`);
    } catch {
      // 次回の低頻度スケジュールで同じ上限内の候補を再確認する。
    }
  }
}

export class DeleteWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: { payload: WorkflowParams }, step: { do: (name: string, options: unknown, operation: () => Promise<void>) => Promise<void> }): Promise<void> {
    await runDeleteWorkflow(this.env, event.payload.async_job_id, (name, operation) =>
      step.do(name, { retries: { limit: 3, delay: '1 second', backoff: 'constant' } }, operation),
    );
  }
}
