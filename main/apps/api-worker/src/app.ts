import { Hono } from 'hono';

import { authenticateDevice, authenticateManagement } from './auth';
import { verifyAccessJwt } from './access-jwt';
import { reserveDeleteJob } from './delete';
import { CORRELATION_ID_HEADER, errorBody, newCorrelationId } from './errors';
import { isDemoWriteAllowed, normalizeUtcRfc3339, retentionDeleteAfter } from './limits';
import type { DeviceIdentity, Env, ManagementIdentity } from './types';
import { validateCanonicalWav, WavValidationError } from './wav';

type Variables = {
  correlationId: string;
};

interface RecordingRow {
  id: string;
  household_id: string;
  source_id: string;
  audio_sha256: string | null;
  analysis_status: string;
  review_status: string;
  version: number;
  captured_at: string;
  captured_timezone: string;
  captured_at_source: string;
  received_at: string;
  upload_status: string;
  audio_object_key: string | null;
  source_type: DeviceIdentity['sourceType'];
  duration_seconds: number;
  pre_roll_seconds: number;
  post_roll_seconds: number;
  draft_scene: string | null;
  draft_parent_note: string | null;
}

interface JobRow {
  id: string;
  status: string;
  correlation_id: string;
  last_error_code: string | null;
}

interface TranscriptRow {
  recording_id: string;
  raw_text: string | null;
  reviewed_text: string | null;
  language: string | null;
}

interface CandidateRow {
  recording_id: string;
  surface: string;
  normalized: string;
  part_of_speech: string | null;
  is_new_candidate: number;
}

function responseError(
  c: { json: (body: unknown, status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 429 | 500) => Response; get: (key: 'correlationId') => string },
  status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 429 | 500,
  code: string,
  message: string,
  retryable = false,
  nextAction = '要求内容を確認してください。',
): Response {
  return c.json(errorBody(c.get('correlationId'), code, message, retryable, nextAction), status);
}

function requestHost(request: Request): string {
  return new URL(request.url).hostname.toLowerCase();
}

function allowedRoute(host: string, method: string, path: string, env: Env): boolean {
  const recordingPath = /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}$/;
  if (host === env.INGEST_HOST) {
    return (
      (method === 'POST' && path === '/api/v1/recordings') ||
      (method === 'POST' && /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/process$/.test(path)) ||
      (method === 'GET' && recordingPath.test(path))
    );
  }
  if (host === env.ADMIN_HOST) {
    if (method === 'DELETE') return recordingPath.test(path);
    return method === 'GET' && (path === '/' || path === '/assets/review.js' || path === '/api/v1/review-queue' || recordingPath.test(path) || /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/audio$/.test(path) || /^\/recordings\/rec_[a-z0-9]{32}$/.test(path));
  }
  return false;
}

function captureIdIsValid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function integerInRange(value: string, minimum: number, maximum: number): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? parsed : null;
}

function validTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function recordingId(): string {
  return `rec_${crypto.randomUUID().replaceAll('-', '')}`;
}

function jobId(): string {
  return `job_${crypto.randomUUID().replaceAll('-', '')}`;
}

function objectKey(id: string): string {
  return `recordings/${id}/audio.wav`;
}

function escapeHtml(value: string | null | undefined): string {
  return (value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function deviceIdentity(c: { req: { raw: Request }; env: Env; get: (key: 'correlationId') => string; json: (body: unknown, status: 401) => Response }): Promise<DeviceIdentity | Response> {
  const identity = await authenticateDevice(c.req.raw, c.env);
  return identity ?? c.json(errorBody(c.get('correlationId'), 'UNAUTHORIZED', '認証情報を確認してください。', false, '有効なデバイストークンを設定してください。'), 401);
}

async function managementIdentity(
  c: { req: { raw: Request }; env: Env; get: (key: 'correlationId') => string; json: (body: unknown, status: 401) => Response },
): Promise<ManagementIdentity | Response> {
  const identity = await authenticateManagement(c.req.raw, { ...c.env, ACCESS_JWT_VERIFY: c.env.ACCESS_JWT_VERIFY ?? verifyAccessJwt });
  return identity ?? c.json(errorBody(c.get('correlationId'), 'UNAUTHORIZED', '管理画面の認証情報を確認してください。', false, 'Cloudflare Accessで認証し直してください。'), 401);
}

function isResponse(value: DeviceIdentity | ManagementIdentity | Response): value is Response {
  return value instanceof Response;
}

async function findDeviceRecording(env: Env, identity: DeviceIdentity, id: string): Promise<RecordingRow | null> {
  return env.DB.prepare(
    `SELECT r.id, r.household_id, r.source_id, r.audio_sha256, r.audio_object_key, r.analysis_status,
            r.review_status, r.version, r.captured_at, r.captured_timezone, r.captured_at_source,
            r.received_at, r.upload_status, r.duration_seconds, r.pre_roll_seconds, r.post_roll_seconds,
            r.draft_scene, r.draft_parent_note, s.source_type
       FROM recordings r JOIN sources s ON s.household_id = r.household_id AND s.id = r.source_id
      WHERE r.id = ? AND r.household_id = ? AND r.source_id = ?`,
  )
    .bind(id, identity.householdId, identity.sourceId)
    .first<RecordingRow>();
}

async function findManagementRecording(env: Env, identity: ManagementIdentity, id: string): Promise<RecordingRow | null> {
  return env.DB.prepare(
    `SELECT r.id, r.household_id, r.source_id, r.audio_sha256, r.audio_object_key, r.analysis_status,
            r.review_status, r.version, r.captured_at, r.captured_timezone, r.captured_at_source,
            r.received_at, r.upload_status, r.duration_seconds, r.pre_roll_seconds, r.post_roll_seconds,
            r.draft_scene, r.draft_parent_note, s.source_type
       FROM recordings r JOIN sources s ON s.household_id = r.household_id AND s.id = r.source_id
      WHERE r.id = ? AND r.household_id = ?`,
  )
    .bind(id, identity.householdId)
    .first<RecordingRow>();
}

function recordingResponse(recording: RecordingRow, deduplicated: boolean, correlationId: string): Record<string, string | number | boolean> {
  return {
    recording_id: recording.id,
    analysis_status: recording.analysis_status,
    review_status: recording.review_status,
    version: recording.version,
    deduplicated,
    correlation_id: correlationId,
  };
}

function acceptedJobResponse(jobIdValue: string, status: string, correlationId: string): Record<string, string> {
  return { async_job_id: jobIdValue, status, correlation_id: correlationId };
}

async function latestJob(env: Env, recordingIdValue: string): Promise<JobRow | null> {
  return env.DB.prepare(
    'SELECT id, status, correlation_id, last_error_code FROM async_jobs WHERE recording_id = ? AND job_type = ? ORDER BY operation_number DESC LIMIT 1',
  )
    .bind(recordingIdValue, 'analysis')
    .first<JobRow>();
}

export const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  const correlationId = newCorrelationId();
  c.set('correlationId', correlationId);
  c.header(CORRELATION_ID_HEADER, correlationId);
  c.header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  const requestUrl = new URL(c.req.raw.url);
  if (
    requestUrl.protocol !== 'https:' ||
    !c.env.ADMIN_HOST ||
    !c.env.INGEST_HOST ||
    !allowedRoute(requestHost(c.req.raw), c.req.method, c.req.path, c.env)
  ) {
    return responseError(c, 404, 'NOT_FOUND', '利用できない経路です。');
  }
  await next();
});

app.onError((_error, c) => {
  const correlationId = c.get('correlationId') || newCorrelationId();
  c.header(CORRELATION_ID_HEADER, correlationId);
  return c.json(errorBody(correlationId, 'INTERNAL_ERROR', '処理中に問題が発生しました。', false, '時間をおいて再度お試しください。'), 500);
});

app.post('/api/v1/recordings', async (c) => {
  const identity = await deviceIdentity(c);
  if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) {
    return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。', false, '読み取り専用で確認してください。');
  }
  const contentLength = c.req.raw.headers.get('Content-Length');
  if (!contentLength) {
    return responseError(c, 411, 'CONTENT_LENGTH_REQUIRED', 'Content-Lengthを指定してください。');
  }
  if (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > 1_120_000) {
    return responseError(c, 413, 'AUDIO_TOO_LARGE', '音声ファイルが上限を超えています。');
  }
  if (!c.req.raw.headers.get('Content-Type')?.startsWith('multipart/form-data;')) {
    return responseError(c, 415, 'UNSUPPORTED_MEDIA_TYPE', 'multipart/form-dataで送信してください。');
  }
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return responseError(c, 400, 'INVALID_MULTIPART', '送信形式が不正です。');
  }
  const audio = form.get('audio');
  const clientCaptureId = form.get('client_capture_id');
  const capturedAt = form.get('captured_at');
  const capturedTimezone = form.get('captured_timezone');
  const preRoll = form.get('pre_roll_seconds');
  const postRoll = form.get('post_roll_seconds');
  const postRollTruncated = form.get('post_roll_truncated');
  const normalizedCapturedAt = typeof capturedAt === 'string' ? normalizeUtcRfc3339(capturedAt) : null;
  if (
    !(audio instanceof File) ||
    typeof clientCaptureId !== 'string' ||
    typeof capturedAt !== 'string' ||
    typeof capturedTimezone !== 'string' ||
    typeof preRoll !== 'string' ||
    typeof postRoll !== 'string' ||
    typeof postRollTruncated !== 'string' ||
    !captureIdIsValid(clientCaptureId) ||
    !normalizedCapturedAt ||
    !validTimeZone(capturedTimezone)
  ) {
    return responseError(c, 422, 'INVALID_RECORDING_INPUT', '録音メタデータが不正です。');
  }
  const preRollSeconds = integerInRange(preRoll, 0, 10);
  const postRollSeconds = integerInRange(postRoll, 0, 5);
  if (preRollSeconds === null || postRollSeconds === null || !['true', 'false'].includes(postRollTruncated)) {
    return responseError(c, 422, 'INVALID_RECORDING_INPUT', '録音メタデータが不正です。');
  }
  let wav;
  try {
    wav = await validateCanonicalWav(new Uint8Array(await audio.arrayBuffer()));
  } catch (error) {
    return responseError(c, error instanceof WavValidationError ? 422 : 400, 'INVALID_WAV', '固定WAV形式ではありません。');
  }
  const existing = await envRecordingByCapture(c.env, identity, clientCaptureId);
  if (existing) {
    if (existing.audio_sha256 !== wav.sha256) {
      return responseError(c, 409, 'IDEMPOTENCY_CONFLICT', '同じ録音IDに異なるデータは送信できません。');
    }
    if (existing.upload_status === 'ready') return c.json(recordingResponse(existing, true, c.get('correlationId')), 200);
    if (existing.upload_status === 'reserved') {
      return responseError(c, 409, 'UPLOAD_IN_PROGRESS', '同じ録音を保存中です。', true, 'しばらく待ってから状態を確認してください。');
    }
    const retry = await c.env.DB.prepare(
      'UPDATE recordings SET upload_status = ?, upload_attempt_count = upload_attempt_count + 1, updated_at = ? WHERE id = ? AND upload_status = ? AND upload_attempt_count < 3',
    )
      .bind('reserved', new Date().toISOString(), existing.id, 'failed')
      .run();
    if ((retry.meta.changes ?? 0) !== 1 || !existing.audio_object_key) {
      return responseError(c, 409, 'UPLOAD_RETRY_LIMIT_REACHED', '音声の再保存上限に達しました。', false, '新しい録音を作成してください。');
    }
    try {
      await c.env.PRIVATE_MEDIA.put(existing.audio_object_key, wav.bytes, { httpMetadata: { contentType: 'audio/wav' } });
      const completedAt = new Date().toISOString();
      await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ?').bind('ready', completedAt, existing.id).run();
      const retried = await findDeviceRecording(c.env, identity, existing.id);
      return retried ? c.json(recordingResponse(retried, true, c.get('correlationId')), 200) : responseError(c, 500, 'RECORDING_STATE_UNAVAILABLE', '録音状態を取得できません。', true);
    } catch {
      await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ?').bind('failed', new Date().toISOString(), existing.id).run();
      return responseError(c, 500, 'MEDIA_STORAGE_FAILED', '音声の保存に失敗しました。', true, '接続を確認して同じ録音を再送してください。');
    }
  }
  const now = new Date();
  const nowText = now.toISOString();
  const id = recordingId();
  const key = objectKey(id);
  const sourceTime = identity.sourceType === 'sample' ? 'server_received' : identity.sourceType === 'pc' ? 'client_clock' : 'device_clock';
  const effectiveCapturedAt = identity.sourceType === 'sample' ? nowText : normalizedCapturedAt;
  const effectiveTimezone = identity.sourceType === 'sample' ? 'UTC' : capturedTimezone;
  let insert: D1Result<unknown>;
  try {
    insert = await c.env.DB.prepare(
      `INSERT INTO recordings (id, household_id, source_id, client_capture_id, captured_at, captured_at_original, captured_at_source, captured_timezone, received_at, pre_roll_seconds, post_roll_seconds, post_roll_truncated, duration_seconds, audio_object_key, audio_sha256, upload_status, analysis_status, review_status, diary_status, image_status, created_at, updated_at, retention_delete_after)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'pending', 'pending', 'not_started', 'not_requested', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM recordings WHERE household_id = ? AND source_id = ? AND client_capture_id = ?)`,
    )
      .bind(
        id,
        identity.householdId,
        identity.sourceId,
        clientCaptureId,
        effectiveCapturedAt,
        effectiveCapturedAt,
        sourceTime,
        effectiveTimezone,
        nowText,
        preRollSeconds,
        postRollSeconds,
        postRollTruncated === 'true' ? 1 : 0,
        wav.durationSeconds,
        key,
        wav.sha256,
        nowText,
        nowText,
        retentionDeleteAfter(now),
        identity.householdId,
        identity.sourceId,
        clientCaptureId,
      )
      .run();
  } catch {
    const raced = await envRecordingByCapture(c.env, identity, clientCaptureId);
    if (raced && raced.audio_sha256 === wav.sha256 && raced.upload_status === 'ready') return c.json(recordingResponse(raced, true, c.get('correlationId')), 200);
    if (raced && raced.audio_sha256 === wav.sha256) return responseError(c, 409, 'UPLOAD_IN_PROGRESS', '同じ録音を保存中または再保存待ちです。', true, 'しばらく待ってから状態を確認してください。');
    if (raced) return responseError(c, 409, 'IDEMPOTENCY_CONFLICT', '同じ録音IDに異なるデータは送信できません。');
    const counter = await c.env.DB.prepare('SELECT used_count FROM usage_counters WHERE counter_key = ? AND usage_day = ?')
      .bind('demo-global:recording_create', nowText.slice(0, 10))
      .first<{ used_count: number }>();
    if ((counter?.used_count ?? 0) >= 30) return responseError(c, 429, 'COST_LIMIT_REACHED', '本日のデモ上限に達しました。', false, '翌UTC日に再度お試しください。');
    return responseError(c, 500, 'RECORDING_RESERVATION_FAILED', '録音の予約に失敗しました。', true, '状態を確認してから再試行してください。');
  }
  if ((insert.meta.changes ?? 0) !== 1) {
    const raced = await envRecordingByCapture(c.env, identity, clientCaptureId);
    if (raced && raced.audio_sha256 === wav.sha256 && raced.upload_status === 'ready') return c.json(recordingResponse(raced, true, c.get('correlationId')), 200);
    if (raced && raced.audio_sha256 === wav.sha256) {
      return responseError(c, 409, 'UPLOAD_IN_PROGRESS', '同じ録音を保存中または再保存待ちです。', true, 'しばらく待ってから状態を確認してください。');
    }
    if (raced) return responseError(c, 409, 'IDEMPOTENCY_CONFLICT', '同じ録音IDに異なるデータは送信できません。');
    return responseError(c, 500, 'RECORDING_RESERVATION_FAILED', '録音の予約に失敗しました。', true, '状態を確認してから再試行してください。');
  }
  try {
    const reserveAttempt = await c.env.DB.prepare(
      'UPDATE recordings SET upload_attempt_count = 1, updated_at = ? WHERE id = ? AND upload_status = ? AND upload_attempt_count = 0',
    )
      .bind(new Date().toISOString(), id, 'reserved')
      .run();
    if ((reserveAttempt.meta.changes ?? 0) !== 1) throw new Error('upload attempt reservation failed');
    await c.env.PRIVATE_MEDIA.put(key, wav.bytes, { httpMetadata: { contentType: 'audio/wav' } });
    await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ?').bind('ready', new Date().toISOString(), id).run();
  } catch {
    await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ?').bind('failed', new Date().toISOString(), id).run();
    return responseError(c, 500, 'MEDIA_STORAGE_FAILED', '音声の保存に失敗しました。', true, '接続を確認して同じ録音を再送してください。');
  }
  const created = await findDeviceRecording(c.env, identity, id);
  if (!created) return responseError(c, 500, 'RECORDING_STATE_UNAVAILABLE', '録音状態を取得できません。', true, '状態を再確認してください。');
  return c.json(recordingResponse(created, false, c.get('correlationId')), 201);
});

async function envRecordingByCapture(env: Env, identity: DeviceIdentity, clientCaptureId: string): Promise<RecordingRow | null> {
  return env.DB.prepare(
    `SELECT r.id, r.household_id, r.source_id, r.audio_sha256, r.audio_object_key, r.analysis_status,
            r.review_status, r.version, r.captured_at, r.captured_timezone, r.captured_at_source,
            r.received_at, r.upload_status, r.duration_seconds, r.pre_roll_seconds, r.post_roll_seconds,
            r.draft_scene, r.draft_parent_note, s.source_type
       FROM recordings r JOIN sources s ON s.household_id = r.household_id AND s.id = r.source_id
      WHERE r.household_id = ? AND r.source_id = ? AND r.client_capture_id = ?`,
  )
    .bind(identity.householdId, identity.sourceId, clientCaptureId)
    .first<RecordingRow>();
}

type DispatchResult = 'dispatch_pending' | 'dispatched' | 'failed' | 'unknown';

async function ensureAnalysisWorkflow(env: Env, id: string): Promise<DispatchResult> {
  let created = false;
  try {
    await env.ANALYSIS_WORKFLOW.create({ id, params: { async_job_id: id } });
    created = true;
  } catch {
    created = false;
  }

  if (!created) {
    try {
      const instance = await env.ANALYSIS_WORKFLOW.get(id);
      const observed = await instance.status();
      const status = typeof observed?.status === 'string' ? observed.status : 'unknown';
      if (status === 'unknown') return 'unknown';
      if (['errored', 'terminated'].includes(status)) {
        const failedAt = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE async_jobs SET status = ?, last_error_code = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = ?',
        )
          .bind('failed', 'WORKFLOW_DISPATCH_FAILED', failedAt, failedAt, id, 'dispatch_pending')
          .run();
        return 'failed';
      }
      if (status === 'complete') {
        const job = await env.DB.prepare('SELECT status FROM async_jobs WHERE id = ?').bind(id).first<{ status: string }>();
        if (job?.status === 'succeeded') return 'dispatched';
        if (job?.status === 'failed') return 'failed';
        return 'unknown';
      }
    } catch {
      await env.DB.prepare('UPDATE async_jobs SET last_error_code = ?, updated_at = ? WHERE id = ? AND status = ?')
        .bind('WORKFLOW_DISPATCH_UNKNOWN', new Date().toISOString(), id, 'dispatch_pending')
        .run()
        .catch(() => undefined);
      return 'unknown';
    }
  }

  try {
    await env.DB.prepare('UPDATE async_jobs SET status = ?, workflow_instance_id = ?, last_error_code = NULL, updated_at = ? WHERE id = ? AND status = ?')
      .bind('dispatched', id, new Date().toISOString(), id, 'dispatch_pending')
      .run();
    return 'dispatched';
  } catch {
    return 'dispatch_pending';
  }
}

app.post('/api/v1/recordings/:id/process', async (c) => {
  const identity = await deviceIdentity(c);
  if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) {
    return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。');
  }
  const recording = await findDeviceRecording(c.env, identity, c.req.param('id'));
  if (!recording) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  if (recording.upload_status !== 'ready') return responseError(c, 409, 'RECORDING_NOT_READY', '録音の保存が完了していません。', true, 'しばらく待ってから状態を確認してください。');
  const currentJob = await c.env.DB.prepare(
    `SELECT id, status, correlation_id, last_error_code FROM async_jobs WHERE recording_id = ? AND job_type = ? AND status IN ('dispatch_pending', 'dispatched', 'running')`,
  )
    .bind(recording.id, 'analysis')
    .first<JobRow>();
  if (currentJob) {
    const dispatch = currentJob.status === 'dispatch_pending' ? await ensureAnalysisWorkflow(c.env, currentJob.id) : currentJob.status;
    if (dispatch === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理の受付結果を確認できません。', false, '状態を確認してから同じ要求を再送してください。');
    if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', true, '状態を確認してから再試行してください。');
    return c.json(acceptedJobResponse(currentJob.id, dispatch, c.get('correlationId')), 202);
  }
  if (recording.analysis_status === 'ready') return responseError(c, 409, 'ALREADY_PROCESSED', '録音はすでに処理済みです。', false, '現在の状態を確認してください。');
  if (['transcribing', 'extracting_words'].includes(recording.analysis_status)) {
    return responseError(c, 500, 'PROCESSING_STATE_UNAVAILABLE', '処理状態を確認できません。', true, '状態を再読み込みしてください。');
  }
  const attemptCount = await c.env.DB.prepare(
    'SELECT COUNT(*) AS attempt_count FROM processing_attempts WHERE recording_id = ? AND processing_kind = ?',
  )
    .bind(recording.id, 'analysis')
    .first<{ attempt_count: number }>();
  if ((attemptCount?.attempt_count ?? 0) >= 3) {
    await c.env.DB.prepare('UPDATE recordings SET analysis_status = ?, updated_at = ? WHERE id = ? AND review_status = ? AND analysis_status <> ?')
      .bind('failed', new Date().toISOString(), recording.id, 'pending', 'ready')
      .run();
    return responseError(c, 409, 'PROCESSING_ATTEMPT_LIMIT_REACHED', '解析の試行上限に達しました。', false, '手動で内容を入力してください。');
  }
  const id = jobId();
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number, correlation_id, created_at, updated_at)
       SELECT ?, ?, ?, 'analysis', 'dispatch_pending',
              COALESCE((SELECT MAX(operation_number) + 1 FROM async_jobs WHERE recording_id = ? AND job_type = 'analysis'), 1),
              ?, ?, ?
        WHERE (SELECT COUNT(*) FROM processing_attempts WHERE recording_id = ? AND processing_kind = 'analysis') < 3
          AND NOT EXISTS (
            SELECT 1 FROM async_jobs WHERE recording_id = ? AND job_type = 'analysis'
              AND status IN ('dispatch_pending', 'dispatched', 'running')
          )`,
    )
      .bind(id, identity.householdId, recording.id, recording.id, c.get('correlationId'), now, now, recording.id, recording.id)
      .run()
      .then((result) => {
        if ((result.meta.changes ?? 0) !== 1) throw new Error('analysis job was not reserved');
      });
  } catch {
    const raced = await c.env.DB.prepare(
      `SELECT id, status, correlation_id, last_error_code FROM async_jobs WHERE recording_id = ? AND job_type = ? AND status IN ('dispatch_pending', 'dispatched', 'running')`,
    )
      .bind(recording.id, 'analysis')
      .first<JobRow>();
    if (raced) {
      const dispatch = raced.status === 'dispatch_pending' ? await ensureAnalysisWorkflow(c.env, raced.id) : raced.status;
      if (dispatch === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理の受付結果を確認できません。', false, '状態を確認してから同じ要求を再送してください。');
      if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', true);
      return c.json(acceptedJobResponse(raced.id, dispatch, c.get('correlationId')), 202);
    }
    const exhausted = await c.env.DB.prepare('SELECT COUNT(*) AS attempt_count FROM processing_attempts WHERE recording_id = ? AND processing_kind = ?')
      .bind(recording.id, 'analysis')
      .first<{ attempt_count: number }>();
    if ((exhausted?.attempt_count ?? 0) >= 3) return responseError(c, 409, 'PROCESSING_ATTEMPT_LIMIT_REACHED', '解析の試行上限に達しました。', false, '手動で内容を入力してください。');
    return responseError(c, 500, 'JOB_RESERVATION_FAILED', '処理の予約に失敗しました。', true, '状態を確認してから再試行してください。');
  }
  const dispatch = await ensureAnalysisWorkflow(c.env, id);
  if (dispatch === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理の受付結果を確認できません。', false, '状態を確認してから同じ要求を再送してください。');
  if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', true, '状態を確認してから再試行してください。');
  return c.json(acceptedJobResponse(id, dispatch, c.get('correlationId')), 202);
});

app.get('/api/v1/recordings/:id', async (c) => {
  const host = requestHost(c.req.raw);
  const identity = host === c.env.INGEST_HOST ? await deviceIdentity(c) : await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const recording = 'sourceId' in identity ? await findDeviceRecording(c.env, identity, c.req.param('id')) : await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording || !['pending', 'approved'].includes(recording.review_status)) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const job = await latestJob(c.env, recording.id);
  const body: Record<string, unknown> = {
    recording_id: recording.id,
    analysis_status: recording.analysis_status,
    review_status: recording.review_status,
    version: recording.version,
    correlation_id: c.get('correlationId'),
  };
  if (job && ['dispatch_pending', 'dispatched', 'running'].includes(job.status)) {
    body.async_job = acceptedJobResponse(job.id, job.status, job.correlation_id);
  } else if (job?.status === 'failed') {
    body.error = errorBody(job.correlation_id, job.last_error_code ?? 'PROCESSING_FAILED', '処理に失敗しました。', false, '手動入力または上限内の再試行を選択してください。');
  }
  return c.json(body);
});

app.delete('/api/v1/recordings/:id', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const contentLength = c.req.raw.headers.get('Content-Length');
  if (!contentLength || !/^[0-9]+$/.test(contentLength) || Number(contentLength) > 1024 || !c.req.raw.headers.get('Content-Type')?.startsWith('application/json')) {
    return responseError(c, 422, 'INVALID_DELETE_INPUT', '削除要求が不正です。');
  }
  let body: unknown;
  try {
    body = await c.req.raw.json();
  } catch {
    return responseError(c, 422, 'INVALID_DELETE_INPUT', '削除要求が不正です。');
  }
  const version = typeof body === 'object' && body !== null && 'version' in body ? (body as { version?: unknown }).version : undefined;
  if (!Number.isSafeInteger(version) || typeof version !== 'number' || version < 1) {
    return responseError(c, 422, 'INVALID_DELETE_INPUT', '削除要求が不正です。');
  }
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const reservation = await reserveDeleteJob(
    c.env,
    { id: recording.id, household_id: recording.household_id, version: recording.version, review_status: recording.review_status },
    version,
    'management_user',
    identity.accessSubject,
    c.get('correlationId'),
  );
  if (reservation.status === 'version_conflict') return responseError(c, 409, 'VERSION_CONFLICT', '録音は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
  if (reservation.status === 'attempt_limit') return responseError(c, 409, 'DELETE_ATTEMPT_LIMIT_REACHED', '削除の試行上限に達しました。', false, '管理者へ連絡してください。');
  if (!reservation.asyncJobId || reservation.status === 'failed') return responseError(c, 500, 'DELETE_RESERVATION_FAILED', '削除を予約できませんでした。', true, '状態を確認してから再試行してください。');
  if (reservation.status === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '削除処理の受付結果を確認できません。', false, '状態を確認してから同じ要求を再送してください。');
  return c.json(acceptedJobResponse(reservation.asyncJobId, reservation.status, c.get('correlationId')), 202);
});

app.get('/api/v1/recordings/:id/audio', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording || recording.upload_status !== 'ready' || !['pending', 'approved'].includes(recording.review_status)) {
    return responseError(c, 404, 'NOT_FOUND', '対象の音声は見つかりません。');
  }
  const object = await c.env.PRIVATE_MEDIA.get(objectKey(recording.id));
  if (!object) return responseError(c, 404, 'NOT_FOUND', '対象の音声は見つかりません。');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Disposition': 'inline; filename="recording.wav"',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      CORRELATION_ID_HEADER: c.get('correlationId'),
    },
  });
});

app.get('/api/v1/review-queue', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const requested = c.req.query('limit') ?? '20';
  const limit = integerInRange(requested, 1, 50);
  if (limit === null) return responseError(c, 422, 'INVALID_LIMIT', '一覧件数が不正です。');
  const result = await c.env.DB.prepare(
    `SELECT r.id, r.household_id, r.source_id, r.audio_sha256, r.audio_object_key, r.analysis_status,
            r.review_status, r.version, r.captured_at, r.captured_timezone, r.captured_at_source,
            r.received_at, r.upload_status, r.duration_seconds, r.pre_roll_seconds, r.post_roll_seconds,
            r.draft_scene, r.draft_parent_note, s.source_type
       FROM recordings r JOIN sources s ON s.household_id = r.household_id AND s.id = r.source_id
      WHERE r.household_id = ? AND r.review_status = 'pending' AND r.upload_status = 'ready'
      ORDER BY r.captured_at DESC, r.created_at DESC LIMIT ?`,
  )
    .bind(identity.householdId, limit)
    .all<RecordingRow>();
  const ids = result.results.map((recording) => recording.id);
  let transcripts: TranscriptRow[] = [];
  let candidates: CandidateRow[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    transcripts = (
      await c.env.DB.prepare(`SELECT recording_id, raw_text, reviewed_text, language FROM transcripts WHERE recording_id IN (${placeholders})`)
        .bind(...ids)
        .all<TranscriptRow>()
    ).results;
    candidates = (
      await c.env.DB.prepare(
        `SELECT recording_id, surface, normalized, part_of_speech, is_new_candidate FROM word_candidates WHERE recording_id IN (${placeholders}) ORDER BY normalized`,
      )
        .bind(...ids)
        .all<CandidateRow>()
    ).results;
  }
  const transcriptByRecording = new Map(transcripts.map((transcript) => [transcript.recording_id, transcript]));
  const wordsByRecording = new Map<string, CandidateRow[]>();
  for (const candidate of candidates) {
    const words = wordsByRecording.get(candidate.recording_id) ?? [];
    words.push(candidate);
    wordsByRecording.set(candidate.recording_id, words);
  }
  const items = result.results.map((recording) => {
    const transcript = transcriptByRecording.get(recording.id);
    return {
      recording: {
        recording_id: recording.id,
        analysis_status: recording.analysis_status,
        review_status: recording.review_status,
        captured_at: recording.captured_at,
        captured_timezone: recording.captured_timezone,
        captured_at_source: recording.captured_at_source,
        source_type: recording.source_type,
        duration_seconds: recording.duration_seconds,
        pre_roll_seconds: recording.pre_roll_seconds,
        post_roll_seconds: recording.post_roll_seconds,
        version: recording.version,
        correlation_id: c.get('correlationId'),
        audio_endpoint: `/api/v1/recordings/${recording.id}/audio`,
      },
      transcript: {
        raw_text: transcript?.raw_text ?? null,
        reviewed_text: transcript?.reviewed_text ?? null,
        language: transcript?.language ?? null,
      },
      word_candidates: (wordsByRecording.get(recording.id) ?? []).map((candidate) => ({
        display_name: candidate.surface,
        normalized: candidate.normalized,
        part_of_speech: candidate.part_of_speech,
        is_new_candidate: candidate.is_new_candidate === 1,
      })),
      scene: recording.draft_scene,
      parent_note: recording.draft_parent_note,
    };
  });
  return c.json({ items, correlation_id: c.get('correlationId') });
});

app.get('/', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Echoes</title></head><body><main><h1>Little Echoes</h1><p id="status">確認待ちの録音を読み込んでいます。</p><ul id="recordings"></ul></main><script src="/assets/review.js"></script></body></html>`);
});

app.get('/recordings/:id', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording || !['pending', 'approved'].includes(recording.review_status)) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const transcript = await c.env.DB.prepare('SELECT raw_text, reviewed_text FROM transcripts WHERE recording_id = ?').bind(recording.id).first<{ raw_text: string | null; reviewed_text: string | null }>();
  const candidates = await c.env.DB.prepare('SELECT surface, normalized FROM word_candidates WHERE recording_id = ? ORDER BY normalized').bind(recording.id).all<{ surface: string; normalized: string }>();
  const status = recording.analysis_status === 'ready' ? '確認待ちです。内容を確認してください。' : recording.analysis_status === 'failed' ? '処理に失敗しました。手動入力または再試行が必要です。' : '処理中です。少し待つと自動で更新されます。';
  const candidateList = candidates.results.map((candidate) => `<li>${escapeHtml(candidate.surface)}（${escapeHtml(candidate.normalized)}）</li>`).join('') || '<li>候補はまだありません。</li>';
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Echoes — 録音</title></head><body><main><p><a href="/">確認待ち一覧へ戻る</a></p><h1>録音の確認</h1><p><strong>状態:</strong> ${escapeHtml(recording.analysis_status)}</p><p>${status}</p><p><strong>録音日時:</strong> ${escapeHtml(recording.captured_at)} (${escapeHtml(recording.captured_timezone)})</p><audio controls preload="metadata" src="/api/v1/recordings/${recording.id}/audio">このブラウザでは音声を再生できません。</audio><h2>文字起こし（モック）</h2><p>${escapeHtml(transcript?.reviewed_text ?? transcript?.raw_text ?? 'まだありません。')}</p><h2>単語候補（モック）</h2><ul>${candidateList}</ul></main></body></html>`);
});

app.get('/assets/review.js', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const script = `fetch('/api/v1/review-queue').then(r=>{if(!r.ok)throw new Error('request failed');return r.json()}).then(data=>{const list=document.getElementById('recordings');document.getElementById('status').textContent=data.items.length?'確認待ちの録音です。':'確認待ちの録音はありません。';for(const item of data.items){const recording=item.recording;if(!/^rec_[a-z0-9]{32}$/.test(recording.recording_id))continue;const li=document.createElement('li');const link=document.createElement('a');link.href='/recordings/'+encodeURIComponent(recording.recording_id);link.textContent=recording.captured_at+' — '+recording.analysis_status;li.append(link);list.append(li)}}).catch(()=>{document.getElementById('status').textContent='読み込みに失敗しました。再読み込みしてください。'});`;
  return new Response(script, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', CORRELATION_ID_HEADER: c.get('correlationId') } });
});
