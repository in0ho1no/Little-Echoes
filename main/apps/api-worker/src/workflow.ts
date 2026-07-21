import { WorkflowEntrypoint } from 'cloudflare:workers';

import { ANALYSIS_STALE_MILLISECONDS, isDemoWriteAllowed } from './limits';
import type { Env, WorkflowParams } from './types';

const MOCK_TRANSCRIPT = 'りんご、たべたい';
const MOCK_WORDS = [
  { surface: 'りんご', normalized: 'りんご' },
  { surface: 'たべたい', normalized: 'たべたい' },
];

interface JobRow {
  id: string;
  recording_id: string;
  household_id: string;
  correlation_id: string;
  operation_number: number;
  status: string;
}

interface AttemptRow {
  status: string;
}

async function failBeforeAttempt(env: Env, job: JobRow, code: string, at: string): Promise<void> {
  await env.DB.batch([
    // 同一ジョブのrunning attemptはこのジョブの失敗と同時に終端しないと、
    // recordingsのactive attemptガードが恒久的に成立し続けて収束経路がなくなる。
    env.DB.prepare(
      `UPDATE processing_attempts SET status = 'failed', error_code = ?, retryable = 0, finished_at = ?
        WHERE job_id = ? AND processing_kind = 'analysis' AND status = 'running'`,
    ).bind(code, at, job.id),
    env.DB.prepare(
      `UPDATE async_jobs SET status = 'failed', last_error_code = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running')`,
    ).bind(code, at, at, job.id),
    env.DB.prepare(
      `UPDATE recordings SET analysis_status = 'failed', updated_at = ?
        WHERE id = ? AND household_id = ? AND review_status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM processing_attempts active
             WHERE active.id = recordings.active_attempt_id AND active.status = 'running'
          )`,
    ).bind(at, job.recording_id, job.household_id),
  ]);
}

async function markCommitUnknown(env: Env, job: JobRow, attemptId: string): Promise<void> {
  const failedAt = new Date().toISOString();
  try {
    const attempt = await env.DB.prepare('SELECT status FROM processing_attempts WHERE id = ?').bind(attemptId).first<AttemptRow>();
    if (attempt?.status === 'succeeded') return;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE processing_attempts SET status = 'unknown', error_code = 'UPSTREAM_RESULT_UNKNOWN', retryable = 0, finished_at = ?
          WHERE id = ? AND status = 'running'`,
      ).bind(failedAt, attemptId),
      env.DB.prepare(
        `UPDATE recordings SET analysis_status = 'failed', updated_at = ?
          WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'`,
      ).bind(failedAt, job.recording_id, job.household_id, attemptId),
      env.DB.prepare(
        `UPDATE async_jobs SET status = 'failed', last_error_code = 'UPSTREAM_RESULT_UNKNOWN', finished_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running')`,
      ).bind(failedAt, failedAt, job.id),
    ]);
  } catch {
    // 結果不明時に例外を再送すると同じ処理を重複実行し得るため、ここでは再throwしない。
  }
}

export async function runMockAnalysis(
  env: Env,
  jobId: string,
  runStep: (name: string, retryLimit: number, operation: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const job = await env.DB.prepare('SELECT id, recording_id, household_id, correlation_id, operation_number, status FROM async_jobs WHERE id = ? AND job_type = ?')
    .bind(jobId, 'analysis')
    .first<JobRow>();
  if (!job || ['succeeded', 'failed'].includes(job.status)) return;

  const startedAt = new Date().toISOString();
  if (!isDemoWriteAllowed(env.DEMO_WRITE_ENABLED)) {
    await failBeforeAttempt(env, job, 'DEMO_WRITE_DISABLED', startedAt);
    return;
  }

  await env.DB.prepare(
    `UPDATE async_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('dispatch_pending', 'dispatched')`,
  )
    .bind(startedAt, startedAt, jobId)
    .run();

  let activeAttemptId: string | null = null;
  try {
    await runStep('mock-analysis', job.operation_number === 1 ? 2 : 1, async () => {
      if (!isDemoWriteAllowed(env.DEMO_WRITE_ENABLED)) {
        await failBeforeAttempt(env, job, 'DEMO_WRITE_DISABLED', new Date().toISOString());
        return;
      }

      const attemptId = `attempt_${crypto.randomUUID().replaceAll('-', '')}`;
      const attemptStartedAt = new Date().toISOString();
      // ジョブ終端化は結果書き込みと同一の原子バッチに含まれるため、
      // ジョブが非終端のまま残るrunning attemptは結果未コミットと判定してよい。
      await env.DB.prepare(
        `UPDATE processing_attempts SET status = 'failed', error_code = 'STEP_REEXECUTED', retryable = 0, finished_at = ?
          WHERE job_id = ? AND processing_kind = 'analysis' AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM async_jobs WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running')
            )`,
      )
        .bind(attemptStartedAt, job.id, job.id)
        .run();
      let reserved = false;
      try {
        const result = await env.DB.prepare(
          `INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind, stage, attempt_number, status, retryable, correlation_id, started_at)
           SELECT ?, ?, ?, ?, 'analysis', 'mock_analysis', COALESCE(MAX(attempt_number), 0) + 1, 'running', 0, ?, ?
             FROM processing_attempts
            WHERE recording_id = ? AND processing_kind = 'analysis'
           HAVING COUNT(*) < 3
              AND COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) = 0`,
        )
          .bind(attemptId, job.household_id, job.recording_id, job.id, job.correlation_id, attemptStartedAt, job.recording_id)
          .run();
        // D1のmeta.changesはBEFORE INSERTトリガー（activate_analysis_attempt）の書き込みを含むため、1との厳密比較はしない。
        reserved = (result.meta.changes ?? 0) >= 1;
      } catch (error) {
        try {
          const committed = await env.DB.prepare('SELECT status FROM processing_attempts WHERE id = ?').bind(attemptId).first<AttemptRow>();
          if (committed) reserved = true;
          else throw error;
        } catch {
          throw error;
        }
      }

      if (!reserved) {
        const attempts = await env.DB.prepare(
          'SELECT COUNT(*) AS attempt_count FROM processing_attempts WHERE recording_id = ? AND processing_kind = ?',
        )
          .bind(job.recording_id, 'analysis')
          .first<{ attempt_count: number }>();
        await failBeforeAttempt(
          env,
          job,
          (attempts?.attempt_count ?? 0) >= 3 ? 'PROCESSING_ATTEMPT_LIMIT_REACHED' : 'STALE_ANALYSIS_JOB',
          new Date().toISOString(),
        );
        return;
      }

      activeAttemptId = attemptId;
      const completedAt = new Date().toISOString();
      const guard = `EXISTS (
        SELECT 1 FROM recordings r
         WHERE r.id = ? AND r.household_id = ? AND r.active_attempt_id = ? AND r.review_status = 'pending'
      )`;
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(
          `INSERT INTO transcripts (recording_id, raw_text, reviewed_text, language, model, prompt_version, created_at, updated_at)
           SELECT ?, ?, NULL, ?, ?, ?, ?, ? FROM recordings WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'
           ON CONFLICT(recording_id) DO UPDATE SET raw_text = excluded.raw_text, language = excluded.language,
             model = excluded.model, prompt_version = excluded.prompt_version, updated_at = excluded.updated_at`,
        ).bind(
          job.recording_id,
          MOCK_TRANSCRIPT,
          'ja',
          'phase2-mock',
          'phase2-v1',
          completedAt,
          completedAt,
          job.recording_id,
          job.household_id,
          attemptId,
        ),
        env.DB.prepare(`DELETE FROM word_candidates WHERE recording_id = ? AND ${guard}`).bind(
          job.recording_id,
          job.recording_id,
          job.household_id,
          attemptId,
        ),
      ];
      for (const word of MOCK_WORDS) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO word_candidates (id, recording_id, surface, normalized, part_of_speech, is_new_candidate)
             SELECT ?, ?, ?, ?, NULL, 1 FROM recordings
              WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'`,
          ).bind(
            `wc_${crypto.randomUUID().replaceAll('-', '')}`,
            job.recording_id,
            word.surface,
            word.normalized,
            job.recording_id,
            job.household_id,
            attemptId,
          ),
        );
      }
      statements.push(
        env.DB.prepare(
          `UPDATE processing_attempts SET status = 'succeeded', finished_at = ?
            WHERE id = ? AND status = 'running' AND ${guard}`,
        ).bind(completedAt, attemptId, job.recording_id, job.household_id, attemptId),
        env.DB.prepare(
          `UPDATE recordings SET analysis_status = 'ready', updated_at = ?
            WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'`,
        ).bind(completedAt, job.recording_id, job.household_id, attemptId),
        env.DB.prepare(
          `UPDATE async_jobs SET status = 'succeeded', last_error_code = NULL, finished_at = ?, updated_at = ?
            WHERE id = ? AND EXISTS (SELECT 1 FROM processing_attempts WHERE id = ? AND status = 'succeeded')`,
        ).bind(completedAt, completedAt, job.id, attemptId),
      );

      try {
        const results = await env.DB.batch(statements);
        const recordingResult = results.at(-2);
        if ((recordingResult?.meta.changes ?? 0) !== 1) {
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE processing_attempts SET status = 'failed', error_code = 'STALE_ANALYSIS_ATTEMPT', retryable = 0, finished_at = ?
                WHERE id = ? AND status = 'running'`,
            ).bind(completedAt, attemptId),
            env.DB.prepare(
              `UPDATE async_jobs SET status = 'failed', last_error_code = 'STALE_ANALYSIS_ATTEMPT', finished_at = ?, updated_at = ?
                WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running')`,
            ).bind(completedAt, completedAt, job.id),
          ]);
        }
      } catch {
        await markCommitUnknown(env, job, attemptId);
      }
    });
  } catch {
    const failedAt = new Date().toISOString();
    if (activeAttemptId) {
      await markCommitUnknown(env, job, activeAttemptId);
    } else {
      await failBeforeAttempt(env, job, 'MOCK_ANALYSIS_FAILED', failedAt);
    }
  }
}

export interface StaleJobRow {
  id: string;
  status: string;
  updated_at: string;
  recording_id: string;
  household_id: string;
}

export async function reconcileStaleAnalysisJob(env: Env, job: StaleJobRow, now = new Date()): Promise<'active' | 'converged' | 'unknown'> {
  if (!['dispatched', 'running'].includes(job.status)) return 'active';
  const updatedAtMilliseconds = Date.parse(job.updated_at);
  if (!Number.isFinite(updatedAtMilliseconds) || now.getTime() - updatedAtMilliseconds < ANALYSIS_STALE_MILLISECONDS) return 'active';
  const nowText = now.toISOString();
  try {
    const instance = await env.ANALYSIS_WORKFLOW.get(job.id);
    const observed = await instance.status();
    const status = typeof observed?.status === 'string' ? observed.status : 'unknown';
    if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(status)) {
      await env.DB.prepare(`UPDATE async_jobs SET updated_at = ? WHERE id = ? AND status IN ('dispatched', 'running')`)
        .bind(nowText, job.id)
        .run()
        .catch(() => undefined);
      return 'active';
    }
    if (['complete', 'errored', 'terminated'].includes(status)) {
      // Workflowが終了済みでジョブが非終端なら、結果バッチは未コミット（同一原子バッチのため）。
      // recordings更新はこのバッチでのジョブ終端化成立に連動させ、並行して着地した
      // succeeded結果を`failed`で上書きしないようにする。
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE processing_attempts SET status = 'failed', error_code = 'UPSTREAM_RESULT_UNKNOWN', retryable = 0, finished_at = ?
            WHERE job_id = ? AND processing_kind = 'analysis' AND status = 'running'
              AND EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status IN ('dispatched', 'running'))`,
        ).bind(nowText, job.id, job.id),
        env.DB.prepare(
          `UPDATE async_jobs SET status = 'failed', last_error_code = 'UPSTREAM_RESULT_UNKNOWN', finished_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('dispatched', 'running')`,
        ).bind(nowText, nowText, job.id),
        env.DB.prepare(
          `UPDATE recordings SET analysis_status = 'failed', updated_at = ?
            WHERE id = ? AND household_id = ? AND review_status = 'pending'
              AND EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status = 'failed')
              AND NOT EXISTS (
                SELECT 1 FROM processing_attempts active
                 WHERE active.id = recordings.active_attempt_id AND active.status = 'running'
              )`,
        ).bind(nowText, job.recording_id, job.household_id, job.id),
      ]);
      return (results[1]?.meta.changes ?? 0) === 1 ? 'converged' : 'active';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: { payload: WorkflowParams }, step: { do: (name: string, options: unknown, operation: () => Promise<void>) => Promise<void> }): Promise<void> {
    await runMockAnalysis(this.env, event.payload.async_job_id, (name, retryLimit, operation) =>
      step.do(name, { retries: { limit: retryLimit, delay: '1 second', backoff: 'constant' } }, operation),
    );
  }
}
