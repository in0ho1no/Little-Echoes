import { WorkflowEntrypoint } from 'cloudflare:workers';

import { ANALYSIS_STALE_MILLISECONDS, isDemoWriteAllowed, MAX_AUDIO_BYTES } from './limits';
import { classifyOpenAiError, createOpenAiAnalysisClient, OpenAiAnalysisError, type OpenAiAnalysisClient, type WordCandidate } from './openai-analysis';
import type { Env, WorkflowParams } from './types';
import { validateCanonicalWav } from './wav';

interface JobRow {
  id: string;
  recording_id: string;
  household_id: string;
  correlation_id: string;
  operation_number: number;
  status: string;
  authorization_token_id: string | null;
  audio_object_key: string | null;
  draft_parent_note: string | null;
}

interface AttemptRow {
  status: string;
}

interface RunStep {
  (name: string, retryLimit: number, operation: () => Promise<void>): Promise<void>;
}

function attemptId(): string {
  return `attempt_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function failBeforeAttempt(env: Env, job: JobRow, code: string, at: string): Promise<void> {
  await env.DB.batch([
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
          AND analysis_status IN ('pending', 'transcribing', 'extracting_words')
          AND EXISTS (
            SELECT 1 FROM async_jobs
             WHERE id = ? AND status = 'failed' AND last_error_code = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM async_jobs newer
             WHERE newer.recording_id = recordings.id AND newer.id <> ?
               AND newer.job_type = 'analysis' AND newer.status IN ('dispatch_pending', 'dispatched', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM processing_attempts active
             WHERE active.id = recordings.active_attempt_id AND active.status = 'running'
          )`,
    ).bind(at, job.recording_id, job.household_id, job.id, code, job.id),
  ]);
}

async function markAttemptFailed(env: Env, attempt: string, error: OpenAiAnalysisError): Promise<void> {
  await env.DB.prepare(
    `UPDATE processing_attempts SET status = 'failed', error_code = ?, retryable = ?, finished_at = ?
      WHERE id = ? AND status = 'running'`,
  )
    .bind(error.code, error.retryable ? 1 : 0, new Date().toISOString(), attempt)
    .run();
}

async function markCommitUnknown(env: Env, job: JobRow, attempt: string): Promise<void> {
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE processing_attempts SET status = 'unknown', error_code = 'UPSTREAM_RESULT_UNKNOWN', retryable = 0, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    ).bind(at, attempt),
    env.DB.prepare(
      `UPDATE async_jobs SET status = 'failed', last_error_code = 'UPSTREAM_RESULT_UNKNOWN', finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running')
          AND EXISTS (
            SELECT 1 FROM processing_attempts
             WHERE id = ? AND status = 'unknown' AND error_code = 'UPSTREAM_RESULT_UNKNOWN'
          )`,
    ).bind(at, at, job.id, attempt),
    env.DB.prepare(
      `UPDATE recordings SET analysis_status = 'failed', updated_at = ?
        WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'
          AND analysis_status IN ('pending', 'transcribing', 'extracting_words')
          AND (SELECT changes()) = 1
          AND EXISTS (
            SELECT 1 FROM async_jobs
             WHERE id = ? AND status = 'failed' AND last_error_code = 'UPSTREAM_RESULT_UNKNOWN' AND updated_at = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM async_jobs newer
             WHERE newer.recording_id = recordings.id AND newer.id <> ?
               AND newer.job_type = 'analysis' AND newer.status IN ('dispatch_pending', 'dispatched', 'running')
          )`,
    ).bind(at, job.recording_id, job.household_id, attempt, job.id, at, job.id),
  ]);
}

async function markCommitUnknownBestEffort(env: Env, job: JobRow, attempt: string): Promise<void> {
  try {
    await markCommitUnknown(env, job, attempt);
  } catch {
    // Do not rethrow after a provider response: a Workflow retry could duplicate the external call.
  }
}

async function reserveAttempt(env: Env, job: JobRow, now: Date): Promise<string | 'limit' | 'blocked'> {
  const id = attemptId();
  const at = now.toISOString();
  await env.DB.prepare(
    `UPDATE processing_attempts SET status = 'failed', error_code = 'STEP_REEXECUTED', retryable = 0, finished_at = ?
      WHERE job_id = ? AND processing_kind = 'analysis' AND status = 'running'
        AND EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running'))`,
  )
    .bind(at, job.id, job.id)
    .run();
  try {
    const result = await env.DB.prepare(
      `INSERT INTO processing_attempts (id, household_id, recording_id, job_id, processing_kind, stage, attempt_number, status, retryable, correlation_id, started_at)
       SELECT ?, ?, ?, ?, 'analysis', 'transcription', COALESCE(MAX(attempt_number), 0) + 1, 'running', 0, ?, ?
         FROM processing_attempts
       WHERE recording_id = ? AND processing_kind = 'analysis'
       HAVING COUNT(*) < 3
          AND COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) = 0
          AND EXISTS (
            SELECT 1 FROM async_jobs j JOIN recordings r ON r.id = j.recording_id AND r.household_id = j.household_id
             JOIN device_tokens d ON d.id = j.authorization_token_id AND d.household_id = r.household_id AND d.source_id = r.source_id
             WHERE j.id = ? AND j.status IN ('dispatch_pending', 'dispatched', 'running')
               AND r.id = ? AND r.household_id = ? AND r.upload_status = 'ready' AND r.review_status = 'pending'
               AND d.revoked_at IS NULL AND d.expires_at > ?
          )`,
    )
      .bind(id, job.household_id, job.recording_id, job.id, job.correlation_id, at, job.recording_id, job.id, job.recording_id, job.household_id, at)
      .run();
    return (result.meta.changes ?? 0) >= 1 ? id : 'blocked';
  } catch (error) {
    if (error instanceof Error && error.message.includes('openai_daily_limit_reached')) {
      await failBeforeAttempt(env, job, 'COST_LIMIT_REACHED', at);
      return 'limit';
    }
    throw error;
  }
}

async function reserveWordExtraction(env: Env, job: JobRow, attempt: string, now: Date): Promise<'reserved' | 'limit' | 'blocked'> {
  const at = now.toISOString();
  try {
    const result = await env.DB.prepare(
      `INSERT INTO openai_call_reservations (attempt_id, stage, usage_day, created_at)
       SELECT ?, 'word_extraction', substr(?, 1, 10), ?
        WHERE EXISTS (
          SELECT 1 FROM processing_attempts a
           JOIN async_jobs j ON j.id = a.job_id
           JOIN recordings r ON r.id = a.recording_id AND r.household_id = a.household_id
           JOIN device_tokens d ON d.id = j.authorization_token_id AND d.household_id = r.household_id AND d.source_id = r.source_id
          WHERE a.id = ? AND a.status = 'running' AND a.stage = 'word_extraction'
            AND j.id = ? AND j.status IN ('dispatch_pending', 'dispatched', 'running')
            AND r.id = ? AND r.household_id = ? AND r.active_attempt_id = ? AND r.upload_status = 'ready' AND r.review_status = 'pending'
            AND d.revoked_at IS NULL AND d.expires_at > ?
        )`,
    ).bind(attempt, at, at, attempt, job.id, job.recording_id, job.household_id, attempt, at).run();
    return (result.meta.changes ?? 0) >= 1 ? 'reserved' : 'blocked';
  } catch (error) {
    if (error instanceof Error && error.message.includes('openai_daily_limit_reached')) return 'limit';
    throw error;
  }
}

function activeGuard(): string {
  return `EXISTS (
    SELECT 1 FROM recordings r
     WHERE r.id = ? AND r.household_id = ? AND r.active_attempt_id = ? AND r.review_status = 'pending'
  )`;
}

async function completeAnalysis(
  env: Env,
  job: JobRow,
  attempt: string,
  transcript: string,
  words: WordCandidate[],
  status: 'ready' | 'partial',
  errorCode: string | null,
): Promise<void> {
  const at = new Date().toISOString();
  const guard = activeGuard();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO transcripts (recording_id, raw_text, reviewed_text, language, model, prompt_version, created_at, updated_at)
       SELECT ?, ?, NULL, 'ja', 'gpt-4o-transcribe', 'transcript-v1', ?, ? FROM recordings
        WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'
       ON CONFLICT(recording_id) DO UPDATE SET raw_text = excluded.raw_text, language = excluded.language,
         model = excluded.model, prompt_version = excluded.prompt_version, updated_at = excluded.updated_at`,
    ).bind(job.recording_id, transcript, at, at, job.recording_id, job.household_id, attempt),
    env.DB.prepare(`DELETE FROM word_candidates WHERE recording_id = ? AND ${guard}`).bind(job.recording_id, job.recording_id, job.household_id, attempt),
  ];
  for (const word of words) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO word_candidates (id, recording_id, surface, normalized, part_of_speech, is_new_candidate)
         SELECT ?, ?, ?, ?, ?, CASE WHEN EXISTS (
           SELECT 1 FROM dictionary_words dw WHERE dw.household_id = ? AND dw.normalized = ?
         ) THEN 0 ELSE 1 END FROM recordings
          WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'`,
      ).bind(
        `wc_${crypto.randomUUID().replaceAll('-', '')}`,
        job.recording_id,
        word.surface,
        word.normalized,
        word.part_of_speech,
        job.household_id,
        word.normalized,
        job.recording_id,
        job.household_id,
        attempt,
      ),
    );
  }
  statements.push(
    env.DB.prepare(`UPDATE processing_attempts SET status = 'succeeded', error_code = ?, retryable = 0, finished_at = ? WHERE id = ? AND status = 'running' AND ${guard}`).bind(
      errorCode,
      at,
      attempt,
      job.recording_id,
      job.household_id,
      attempt,
    ),
    env.DB.prepare(`UPDATE recordings SET analysis_status = ?, updated_at = ? WHERE id = ? AND household_id = ? AND active_attempt_id = ? AND review_status = 'pending'`).bind(
      status,
      at,
      job.recording_id,
      job.household_id,
      attempt,
    ),
    env.DB.prepare(
      `UPDATE async_jobs SET status = 'succeeded', last_error_code = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM processing_attempts WHERE id = ? AND status = 'succeeded')`,
    ).bind(errorCode, at, at, job.id, attempt),
  );
  const result = await env.DB.batch(statements);
  const recordingResult = result.at(-2);
  if ((recordingResult?.meta.changes ?? 0) === 0) await markCommitUnknown(env, job, attempt);
}

async function loadJob(env: Env, jobId: string): Promise<JobRow | null> {
  return env.DB.prepare(
    `SELECT j.id, j.recording_id, j.household_id, j.correlation_id, j.operation_number, j.status, j.authorization_token_id,
            r.audio_object_key, r.draft_parent_note
       FROM async_jobs j JOIN recordings r ON r.id = j.recording_id AND r.household_id = j.household_id
      WHERE j.id = ? AND j.job_type = 'analysis'`,
  )
    .bind(jobId)
    .first<JobRow>();
}

export async function runOpenAiAnalysis(env: Env, jobId: string, runStep: RunStep, client?: OpenAiAnalysisClient, clock: () => Date = () => new Date()): Promise<void> {
  const job = await loadJob(env, jobId);
  if (!job || ['succeeded', 'failed'].includes(job.status)) return;
  const startedNow = clock();
  const startedAt = startedNow.toISOString();
  if (!isDemoWriteAllowed(env.DEMO_WRITE_ENABLED, startedNow)) return failBeforeAttempt(env, job, 'DEMO_WRITE_DISABLED', startedAt);
  if (!job.audio_object_key) return failBeforeAttempt(env, job, 'AUDIO_NOT_AVAILABLE', startedAt);
  if (!env.OPENAI_API_KEY && !client) return failBeforeAttempt(env, job, 'OPENAI_NOT_CONFIGURED', startedAt);

  const object = await env.PRIVATE_MEDIA.get(job.audio_object_key);
  if (!object) return failBeforeAttempt(env, job, 'AUDIO_NOT_AVAILABLE', startedAt);
  if (object.size > MAX_AUDIO_BYTES) return failBeforeAttempt(env, job, 'INVALID_AUDIO', startedAt);
  let wav: Uint8Array;
  try {
    wav = (await validateCanonicalWav(new Uint8Array(await object.arrayBuffer()))).bytes;
  } catch {
    return failBeforeAttempt(env, job, 'INVALID_AUDIO', startedAt);
  }
  const analysisClient = client ?? createOpenAiAnalysisClient(env.OPENAI_API_KEY as string);
  await env.DB.prepare(
    `UPDATE async_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('dispatch_pending', 'dispatched')`,
  )
    .bind(startedAt, startedAt, job.id)
    .run();

  let currentAttempt: string | null = null;
  let latestTranscript: string | null = null;
  try {
    await runStep('openai-analysis', job.operation_number === 1 ? 2 : 1, async () => {
      // Each Workflow retry owns a new attempt. Never carry a prior call's result into it.
      currentAttempt = null;
      latestTranscript = null;
      const attemptNow = clock();
      if (!isDemoWriteAllowed(env.DEMO_WRITE_ENABLED, attemptNow)) return failBeforeAttempt(env, job, 'DEMO_WRITE_DISABLED', attemptNow.toISOString());
      const reserved = await reserveAttempt(env, job, attemptNow);
      if (reserved === 'limit') return;
      if (reserved === 'blocked') {
        const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM processing_attempts WHERE recording_id = ? AND processing_kind = 'analysis'`)
          .bind(job.recording_id)
          .first<{ count: number }>();
        await failBeforeAttempt(env, job, (count?.count ?? 0) >= 3 ? 'PROCESSING_ATTEMPT_LIMIT_REACHED' : 'ANALYSIS_STATE_CHANGED', attemptNow.toISOString());
        return;
      }
      currentAttempt = reserved;
      let transcriptResult;
      try {
        const transcriptionNow = clock();
        if (!isDemoWriteAllowed(env.DEMO_WRITE_ENABLED, transcriptionNow)) return failBeforeAttempt(env, job, 'DEMO_WRITE_DISABLED', transcriptionNow.toISOString());
        transcriptResult = await analysisClient.transcribe(wav);
      } catch (error) {
        const classified = classifyOpenAiError(error);
        if (classified.code === 'UPSTREAM_RESULT_UNKNOWN') {
          await markCommitUnknownBestEffort(env, job, reserved);
          return;
        }
        try {
          await markAttemptFailed(env, reserved, classified);
        } catch {
          if (!classified.retryable) await markCommitUnknownBestEffort(env, job, reserved);
        }
        if (classified.retryable) throw classified;
        try {
          await failBeforeAttempt(env, job, classified.code, new Date().toISOString());
        } catch {
          await markCommitUnknownBestEffort(env, job, reserved);
        }
        return;
      }
      try {
        const transcript = transcriptResult.value.trim();
        latestTranscript = transcript;
        await env.DB.prepare(`UPDATE processing_attempts SET provider_request_id = ? WHERE id = ? AND status = 'running'`).bind(transcriptResult.requestId, reserved).run();
        if (!transcript) return completeAnalysis(env, job, reserved, '', [], 'partial', 'EMPTY_TRANSCRIPT');
        if (transcript.length > 2_000) return failBeforeAttempt(env, job, 'TRANSCRIPT_TOO_LONG', clock().toISOString());

        await env.DB.batch([
          env.DB.prepare(`UPDATE processing_attempts SET stage = 'word_extraction' WHERE id = ? AND status = 'running'`).bind(reserved),
          env.DB.prepare(`UPDATE recordings SET analysis_status = 'extracting_words', updated_at = ? WHERE id = ? AND active_attempt_id = ? AND review_status = 'pending'`).bind(
            new Date().toISOString(),
            job.recording_id,
            reserved,
          ),
        ]);
        const extractionNow = clock();
        if (!isDemoWriteAllowed(env.DEMO_WRITE_ENABLED, extractionNow)) return completeAnalysis(env, job, reserved, transcript, [], 'partial', 'DEMO_WRITE_DISABLED');
        const extractionReservation = await reserveWordExtraction(env, job, reserved, extractionNow);
        if (extractionReservation === 'limit') return completeAnalysis(env, job, reserved, transcript, [], 'partial', 'COST_LIMIT_REACHED');
        if (extractionReservation === 'blocked') return completeAnalysis(env, job, reserved, transcript, [], 'partial', 'ANALYSIS_STATE_CHANGED');
        let words: { value: WordCandidate[]; requestId: string | null };
        try {
          words = await analysisClient.extractWords(transcript, job.draft_parent_note);
        } catch (error) {
          const classified = classifyOpenAiError(error);
          if (classified.retryable) throw classified;
          // The transcript is useful even when word extraction is refused, malformed, or unavailable.
          await completeAnalysis(env, job, reserved, transcript, [], 'partial', classified.code);
          return;
        }
        try {
          await env.DB.prepare(`UPDATE processing_attempts SET provider_request_id = ? WHERE id = ? AND status = 'running'`).bind(words.requestId, reserved).run();
          await completeAnalysis(env, job, reserved, transcript, words.value, words.value.length === 0 ? 'partial' : 'ready', words.value.length === 0 ? 'EMPTY_WORD_CANDIDATES' : null);
        } catch {
          await markCommitUnknownBestEffort(env, job, reserved);
        }
      } catch (error) {
        if (error instanceof OpenAiAnalysisError && error.retryable) throw error;
        await markCommitUnknownBestEffort(env, job, reserved);
      }
    });
  } catch (error) {
    const classified = classifyOpenAiError(error);
    if (currentAttempt && latestTranscript) {
      try {
        await completeAnalysis(env, job, currentAttempt, latestTranscript, [], 'partial', classified.code);
      } catch {
        await markCommitUnknownBestEffort(env, job, currentAttempt);
      }
      return;
    }
    try {
      if (currentAttempt) await markAttemptFailed(env, currentAttempt, classified);
      await failBeforeAttempt(env, job, classified.code, new Date().toISOString());
    } catch {
      if (currentAttempt) await markCommitUnknownBestEffort(env, job, currentAttempt);
    }
  }
}

/** @deprecated Compatibility shim for Phase 2 fixtures; production uses runOpenAiAnalysis. */
export async function runMockAnalysis(env: Env, jobId: string, runStep: RunStep): Promise<void> {
  if (typeof (env.PRIVATE_MEDIA as Partial<R2Bucket>).get !== 'function') {
    const job = await loadJob(env, jobId);
    if (job) await failBeforeAttempt(env, job, 'AUDIO_NOT_AVAILABLE', new Date().toISOString());
    return;
  }
  const fixtureClient: OpenAiAnalysisClient = {
    transcribe: async () => ({ value: 'りんご、たべたい', requestId: null }),
    extractWords: async () => ({
      value: [
        { surface: 'りんご', normalized: 'りんご', part_of_speech: null },
        { surface: 'たべたい', normalized: 'たべたい', part_of_speech: null },
      ],
      requestId: null,
    }),
  };
  await runOpenAiAnalysis(env, jobId, runStep, fixtureClient);
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
  const updatedAt = Date.parse(job.updated_at);
  if (!Number.isFinite(updatedAt) || now.getTime() - updatedAt < ANALYSIS_STALE_MILLISECONDS) return 'active';
  const at = now.toISOString();
  try {
    const observed = await (await env.ANALYSIS_WORKFLOW.get(job.id)).status();
    if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(String(observed?.status))) {
      await env.DB.prepare(`UPDATE async_jobs SET updated_at = ? WHERE id = ? AND status IN ('dispatched', 'running')`).bind(at, job.id).run();
      return 'active';
    }
    if (!['complete', 'errored', 'terminated'].includes(String(observed?.status))) return 'unknown';
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE processing_attempts SET status = 'failed', error_code = 'UPSTREAM_RESULT_UNKNOWN', retryable = 0, finished_at = ? WHERE job_id = ? AND processing_kind = 'analysis' AND status = 'running'`).bind(at, job.id),
      env.DB.prepare(`UPDATE async_jobs SET status = 'failed', last_error_code = 'UPSTREAM_RESULT_UNKNOWN', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('dispatched', 'running')`).bind(at, at, job.id),
      env.DB.prepare(
        `UPDATE recordings SET analysis_status = 'failed', updated_at = ?
          WHERE id = ? AND household_id = ? AND review_status = 'pending'
            AND EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status = 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM processing_attempts active
               WHERE active.id = recordings.active_attempt_id AND active.status = 'running'
            )`,
      ).bind(at, job.recording_id, job.household_id, job.id),
    ]);
    return (results[1]?.meta.changes ?? 0) >= 1 ? 'converged' : 'active';
  } catch {
    return 'unknown';
  }
}

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: { payload: WorkflowParams }, step: { do: (name: string, options: unknown, operation: () => Promise<void>) => Promise<void> }): Promise<void> {
    await runOpenAiAnalysis(this.env, event.payload.async_job_id, (name, retryLimit, operation) =>
      step.do(name, { retries: { limit: retryLimit, delay: '1 second', backoff: 'constant' } }, operation),
    );
  }
}
