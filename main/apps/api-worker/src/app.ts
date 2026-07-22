import { Hono } from 'hono';

import { authenticateDevice, authenticateManagement } from './auth';
import { verifyAccessJwt } from './access-jwt';
import { reserveDeleteJob } from './delete';
import { CORRELATION_ID_HEADER, errorBody, newCorrelationId } from './errors';
import { ANALYSIS_STALE_MILLISECONDS, isDemoWriteAllowed, normalizeUtcRfc3339, retentionDeleteAfter, UPLOAD_RESERVED_STALE_MILLISECONDS } from './limits';
import { approveReview, saveReview, type ReviewInput, type ReviewTarget } from './review';
import type { DeviceIdentity, Env, ManagementIdentity } from './types';
import { validateCanonicalWav, WavValidationError } from './wav';
import { reconcileStaleAnalysisJob } from './workflow';

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
  updated_at: string;
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
  const reviewPath = /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/review$/;
  const approvalPath = /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/approve$/;
  const dictionaryPath = /^\/api\/v1\/dictionary\/word_[a-z0-9]{32}$/;
  if (host === env.INGEST_HOST) {
    return (
      (method === 'POST' && path === '/api/v1/recordings') ||
      (method === 'POST' && /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/process$/.test(path)) ||
      (method === 'GET' && recordingPath.test(path))
    );
  }
  if (host === env.ADMIN_HOST) {
    if (method === 'DELETE') return recordingPath.test(path);
    if (method === 'PATCH') return reviewPath.test(path);
    if (method === 'POST') return approvalPath.test(path);
    return (
      method === 'GET' &&
      (path === '/' ||
        path === '/dictionary' ||
        /^\/dictionary\/word_[a-z0-9]{32}$/.test(path) ||
        path === '/assets/review.js' ||
        path === '/assets/review-detail.js' ||
        path === '/api/v1/review-queue' ||
        path === '/api/v1/dictionary' ||
        dictionaryPath.test(path) ||
        recordingPath.test(path) ||
        /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/audio$/.test(path) ||
        /^\/recordings\/rec_[a-z0-9]{32}$/.test(path))
    );
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

function containsDisallowedControl(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value);
}

function normalizedText(value: unknown, maximum: number, allowEmpty: boolean): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC');
  if (normalized.length > maximum || containsDisallowedControl(normalized) || (!allowEmpty && normalized.trim().length === 0)) return null;
  return normalized;
}

function parseReviewInput(body: unknown): ReviewInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowedKeys = new Set(['version', 'reviewed_text', 'words', 'captured_at', 'captured_timezone', 'scene', 'parent_note']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (!Number.isSafeInteger(value.version) || typeof value.version !== 'number' || value.version < 1 || !Array.isArray(value.words)) return null;
  const reviewedText = normalizedText(value.reviewed_text, 2000, true);
  const capturedAt = typeof value.captured_at === 'string' ? normalizeUtcRfc3339(value.captured_at) : null;
  const capturedTimezone = typeof value.captured_timezone === 'string' && validTimeZone(value.captured_timezone) ? value.captured_timezone : null;
  const scene = value.scene === undefined || value.scene === null ? null : normalizedText(value.scene, 300, true);
  const parentNote = value.parent_note === undefined || value.parent_note === null ? null : normalizedText(value.parent_note, 2000, true);
  if (reviewedText === null || !capturedAt || !capturedTimezone || scene === null && value.scene !== undefined && value.scene !== null || parentNote === null && value.parent_note !== undefined && value.parent_note !== null || value.words.length > 30) {
    return null;
  }
  const seen = new Set<string>();
  const words: ReviewInput['words'] = [];
  for (const item of value.words) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const word = item as Record<string, unknown>;
    const keys = Object.keys(word);
    if (keys.length !== 3 || !['display_name', 'normalized', 'new_override'].every((key) => key in word)) return null;
    const displayName = normalizedText(word.display_name, 100, false)?.trim();
    const normalized = normalizedText(word.normalized, 100, false)?.trim().toLocaleLowerCase('ja-JP');
    if (!displayName || !normalized || seen.has(normalized) || !['auto', 'force_new', 'force_not_new'].includes(word.new_override as string)) return null;
    seen.add(normalized);
    words.push({ displayName, normalized, newOverride: word.new_override as ReviewInput['words'][number]['newOverride'] });
  }
  return { version: value.version, reviewedText, words, capturedAt, capturedTimezone, scene, parentNote };
}

async function parseReviewRequest(c: { req: { raw: Request }; get: (key: 'correlationId') => string; json: (body: unknown, status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 429 | 500) => Response }): Promise<ReviewInput | Response> {
  const contentLength = c.req.raw.headers.get('Content-Length');
  if ((contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > 16_384)) || !c.req.raw.headers.get('Content-Type')?.startsWith('application/json')) {
    return responseError(c, 422, 'INVALID_REVIEW_INPUT', '確認内容の形式またはサイズが不正です。');
  }
  let body: unknown;
  try {
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    if (bytes.byteLength > 16_384) return responseError(c, 422, 'INVALID_REVIEW_INPUT', '確認内容の形式またはサイズが不正です。');
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return responseError(c, 422, 'INVALID_REVIEW_INPUT', '確認内容の形式が不正です。');
  }
  const input = parseReviewInput(body);
  return input ?? responseError(c, 422, 'INVALID_REVIEW_INPUT', '確認内容を確認してください。');
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
    'SELECT id, status, correlation_id, last_error_code, updated_at FROM async_jobs WHERE recording_id = ? AND job_type = ? ORDER BY operation_number DESC LIMIT 1',
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
      const reconcileNow = new Date();
      const converged = await c.env.DB.prepare(
        'UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ? AND upload_status = ? AND updated_at <= ?',
      )
        .bind(
          'failed',
          reconcileNow.toISOString(),
          existing.id,
          'reserved',
          new Date(reconcileNow.getTime() - UPLOAD_RESERVED_STALE_MILLISECONDS).toISOString(),
        )
        .run();
      if ((converged.meta.changes ?? 0) !== 1) {
        return responseError(c, 409, 'UPLOAD_IN_PROGRESS', '同じ録音を保存中です。', true, 'しばらく待ってから状態を確認してください。');
      }
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
      await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ? AND upload_status = ?').bind('ready', completedAt, existing.id, 'reserved').run();
      const retried = await findDeviceRecording(c.env, identity, existing.id);
      return retried ? c.json(recordingResponse(retried, true, c.get('correlationId')), 200) : responseError(c, 500, 'RECORDING_STATE_UNAVAILABLE', '録音状態を取得できません。', true);
    } catch {
      await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ? AND upload_status = ?').bind('failed', new Date().toISOString(), existing.id, 'reserved').run();
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
  // D1のmeta.changesはBEFORE INSERTトリガー（日次上限カウンター）の書き込みを含むため、1との厳密比較はしない。
  if ((insert.meta.changes ?? 0) === 0) {
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
    await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ? AND upload_status = ?').bind('ready', new Date().toISOString(), id, 'reserved').run();
  } catch {
    await c.env.DB.prepare('UPDATE recordings SET upload_status = ?, updated_at = ? WHERE id = ? AND upload_status = ?').bind('failed', new Date().toISOString(), id, 'reserved').run();
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
  let recording = 'sourceId' in identity ? await findDeviceRecording(c.env, identity, c.req.param('id')) : await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording || !['pending', 'approved'].includes(recording.review_status)) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  let job = await latestJob(c.env, recording.id);
  if (job && job.status === 'dispatch_pending') {
    const pendingSince = Date.parse(job.updated_at);
    if (Number.isFinite(pendingSince) && Date.now() - pendingSince >= ANALYSIS_STALE_MILLISECONDS) {
      const dispatch = await ensureAnalysisWorkflow(c.env, job.id);
      if (dispatch === 'dispatched') job = { ...job, status: 'dispatched' };
      else if (dispatch === 'failed') job = { ...job, status: 'failed', last_error_code: job.last_error_code ?? 'WORKFLOW_DISPATCH_FAILED' };
    }
  }
  if (job && ['dispatched', 'running'].includes(job.status)) {
    const reconciled = await reconcileStaleAnalysisJob(c.env, {
      id: job.id,
      status: job.status,
      updated_at: job.updated_at,
      recording_id: recording.id,
      household_id: recording.household_id,
    });
    if (reconciled === 'converged') {
      job = { ...job, status: 'failed', last_error_code: 'UPSTREAM_RESULT_UNKNOWN' };
      const refreshed =
        'sourceId' in identity ? await findDeviceRecording(c.env, identity, recording.id) : await findManagementRecording(c.env, identity, recording.id);
      recording = refreshed ?? recording;
    }
  }
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

function reviewTarget(recording: RecordingRow): ReviewTarget {
  return {
    id: recording.id,
    householdId: recording.household_id,
    version: recording.version,
    reviewStatus: recording.review_status,
    analysisStatus: recording.analysis_status,
    capturedAt: recording.captured_at,
  };
}

function reviewResultError(c: { json: (body: unknown, status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 429 | 500) => Response; get: (key: 'correlationId') => string }, result: 'version_conflict' | 'not_reviewable'): Response {
  if (result === 'version_conflict') return responseError(c, 409, 'VERSION_CONFLICT', '録音は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
  return responseError(c, 409, 'REVIEW_NOT_AVAILABLE', '処理中または削除中の録音は確認できません。', false, '処理完了後に再度確認してください。');
}

app.patch('/api/v1/recordings/:id/review', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) {
    return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。', false, '読み取り専用で確認してください。');
  }
  const input = await parseReviewRequest(c);
  if (input instanceof Response) return input;
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const result =
    recording.review_status === 'approved'
      ? await approveReview(c.env.DB, reviewTarget(recording), input, identity.accessSubject, c.get('correlationId'))
      : await saveReview(c.env.DB, reviewTarget(recording), input, identity.accessSubject, c.get('correlationId'));
  if (result !== 'saved') return reviewResultError(c, result);
  const saved = await findManagementRecording(c.env, identity, recording.id);
  if (!saved) return responseError(c, 500, 'RECORDING_STATE_UNAVAILABLE', '録音状態を取得できません。', true);
  return c.json(recordingResponse(saved, false, c.get('correlationId')), 200);
});

app.post('/api/v1/recordings/:id/approve', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) {
    return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。', false, '読み取り専用で確認してください。');
  }
  const input = await parseReviewRequest(c);
  if (input instanceof Response) return input;
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const result = await approveReview(c.env.DB, reviewTarget(recording), input, identity.accessSubject, c.get('correlationId'));
  if (result !== 'saved') return reviewResultError(c, result);
  const approved = await findManagementRecording(c.env, identity, recording.id);
  if (!approved) return responseError(c, 500, 'RECORDING_STATE_UNAVAILABLE', '録音状態を取得できません。', true);
  return c.json(recordingResponse(approved, false, c.get('correlationId')), 200);
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
      [CORRELATION_ID_HEADER]: c.get('correlationId'),
    },
  });
});

interface DictionaryWordRow {
  id: string;
  display_name: string;
  normalized: string;
  first_spoken_at: string | null;
  occurrence_count: number;
}

interface DictionaryOccurrenceRow {
  recording_id: string;
  surface: string;
  utterance_text: string | null;
  spoken_at: string;
  is_first: number;
  new_override: 'auto' | 'force_new' | 'force_not_new';
  diary_id: string | null;
}

export function isNewForDisplay(occurrence: Pick<DictionaryOccurrenceRow, 'is_first' | 'new_override'>): boolean {
  return occurrence.new_override === 'force_new' || (occurrence.new_override !== 'force_not_new' && occurrence.is_first === 1);
}

function dictionaryWordBody(word: DictionaryWordRow, history: DictionaryOccurrenceRow[], correlationId: string): Record<string, unknown> {
  return {
    word_id: word.id,
    display_name: word.display_name,
    normalized: word.normalized,
    first_spoken_at: word.first_spoken_at,
    occurrence_count: word.occurrence_count,
    history: history.map((occurrence) => ({
      recording_id: occurrence.recording_id,
      surface: occurrence.surface,
      utterance_text: occurrence.utterance_text ?? '',
      spoken_at: occurrence.spoken_at,
      is_first: isNewForDisplay(occurrence),
      new_override: occurrence.new_override,
      diary_id: occurrence.diary_id,
      audio_endpoint: `/api/v1/recordings/${occurrence.recording_id}/audio`,
    })),
    correlation_id: correlationId,
  };
}

app.get('/api/v1/dictionary', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const requested = c.req.query('limit') ?? '20';
  const limit = integerInRange(requested, 1, 100);
  if (limit === null) return responseError(c, 422, 'INVALID_LIMIT', '一覧件数が不正です。');
  const words = await c.env.DB.prepare(
    `SELECT id, display_name, normalized, first_spoken_at, occurrence_count FROM dictionary_words
      WHERE household_id = ? AND occurrence_count > 0
      ORDER BY first_spoken_at DESC, id DESC LIMIT ?`,
  )
    .bind(identity.householdId, limit)
    .all<DictionaryWordRow>();
  return c.json({
    items: words.results.map((word) => dictionaryWordBody(word, [], c.get('correlationId'))),
    correlation_id: c.get('correlationId'),
  });
});

app.get('/api/v1/dictionary/:id', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const requested = c.req.query('limit') ?? '20';
  const limit = integerInRange(requested, 1, 100);
  if (limit === null) return responseError(c, 422, 'INVALID_LIMIT', '一覧件数が不正です。');
  const word = await c.env.DB.prepare(
    `SELECT id, display_name, normalized, first_spoken_at, occurrence_count FROM dictionary_words
      WHERE id = ? AND household_id = ? AND occurrence_count > 0`,
  )
    .bind(c.req.param('id'), identity.householdId)
    .first<DictionaryWordRow>();
  if (!word) return responseError(c, 404, 'NOT_FOUND', '対象の単語は見つかりません。');
  const history = await c.env.DB.prepare(
    `SELECT wo.recording_id, wo.surface, COALESCE(t.reviewed_text, t.raw_text, '') AS utterance_text,
            wo.spoken_at, wo.is_first, wo.new_override, d.id AS diary_id
       FROM word_occurrences wo
       JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
       LEFT JOIN transcripts t ON t.recording_id = wo.recording_id
       LEFT JOIN diary_entries d ON d.recording_id = wo.recording_id
      WHERE wo.dictionary_word_id = ? AND wo.household_id = ? AND r.review_status = 'approved'
      ORDER BY r.captured_at DESC, r.created_at DESC, wo.recording_id DESC LIMIT ?`,
  )
    .bind(word.id, identity.householdId, limit)
    .all<DictionaryOccurrenceRow>();
  return c.json(dictionaryWordBody(word, history.results, c.get('correlationId')));
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
  const failedDeletions = await c.env.DB.prepare(
    `SELECT id, captured_at, captured_timezone, version FROM recordings
      WHERE household_id = ? AND review_status = 'delete_failed'
      ORDER BY captured_at DESC, created_at DESC LIMIT 20`,
  )
    .bind(identity.householdId)
    .all<{ id: string; captured_at: string; captured_timezone: string; version: number }>();
  return c.json({
    items,
    failed_deletions: failedDeletions.results.map((recording) => ({
      recording_id: recording.id,
      captured_at: recording.captured_at,
      captured_timezone: recording.captured_timezone,
      version: recording.version,
    })),
    correlation_id: c.get('correlationId'),
  });
});

app.get('/', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Echoes</title></head><body><main><h1>Little Echoes</h1><p><a href="/dictionary">ことば辞典</a></p><p id="status">確認待ちの録音を読み込んでいます。</p><ul id="recordings"></ul></main><script src="/assets/review.js"></script></body></html>`);
});

app.get('/dictionary', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const words = await c.env.DB.prepare(
    `SELECT id, display_name, normalized, first_spoken_at, occurrence_count FROM dictionary_words
      WHERE household_id = ? AND occurrence_count > 0 ORDER BY first_spoken_at DESC, id DESC LIMIT 100`,
  )
    .bind(identity.householdId)
    .all<DictionaryWordRow>();
  const list =
    words.results
      .map((word) => `<li><a href="/dictionary/${encodeURIComponent(word.id)}">${escapeHtml(word.display_name)}</a>（${word.occurrence_count}件）</li>`)
      .join('') || '<li>承認済みの単語はまだありません。</li>';
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Echoes — ことば辞典</title></head><body><main><p><a href="/">確認待ち一覧へ戻る</a></p><h1>ことば辞典</h1><ul>${list}</ul></main></body></html>`);
});

app.get('/dictionary/:id', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const word = await c.env.DB.prepare(
    `SELECT id, display_name, normalized, first_spoken_at, occurrence_count FROM dictionary_words
      WHERE id = ? AND household_id = ? AND occurrence_count > 0`,
  )
    .bind(c.req.param('id'), identity.householdId)
    .first<DictionaryWordRow>();
  if (!word) return responseError(c, 404, 'NOT_FOUND', '対象の単語は見つかりません。');
  const history = await c.env.DB.prepare(
    `SELECT wo.recording_id, wo.surface, COALESCE(t.reviewed_text, t.raw_text, '') AS utterance_text,
            wo.spoken_at, wo.is_first, wo.new_override, d.id AS diary_id
       FROM word_occurrences wo JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
       LEFT JOIN transcripts t ON t.recording_id = wo.recording_id LEFT JOIN diary_entries d ON d.recording_id = wo.recording_id
      WHERE wo.dictionary_word_id = ? AND wo.household_id = ? AND r.review_status = 'approved'
      ORDER BY r.captured_at DESC, r.created_at DESC, wo.recording_id DESC LIMIT 100`,
  )
    .bind(word.id, identity.householdId)
    .all<DictionaryOccurrenceRow>();
  const list =
    history.results
      .map(
        (occurrence) =>
          `<li>${isNewForDisplay(occurrence) ? '<strong>NEW</strong> ' : ''}${escapeHtml(occurrence.spoken_at)} — ${escapeHtml(occurrence.utterance_text ?? '')} <a href="/recordings/${encodeURIComponent(occurrence.recording_id)}">録音を開く</a></li>`,
      )
      .join('') || '<li>発話履歴はありません。</li>';
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Echoes — ${escapeHtml(word.display_name)}</title></head><body><main><p><a href="/dictionary">ことば辞典へ戻る</a></p><h1>${escapeHtml(word.display_name)}</h1><p>記録回数: ${word.occurrence_count}</p><h2>発話履歴</h2><ul>${list}</ul></main></body></html>`);
});

app.get('/recordings/:id', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording || !['pending', 'approved'].includes(recording.review_status)) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const transcript = await c.env.DB.prepare('SELECT raw_text, reviewed_text FROM transcripts WHERE recording_id = ?').bind(recording.id).first<{ raw_text: string | null; reviewed_text: string | null }>();
  const editableWords =
    recording.review_status === 'approved'
      ? await c.env.DB.prepare(
          `SELECT wo.surface, dw.normalized, wo.new_override
             FROM word_occurrences wo JOIN dictionary_words dw ON dw.id = wo.dictionary_word_id AND dw.household_id = wo.household_id
            WHERE wo.recording_id = ? AND wo.household_id = ? ORDER BY dw.normalized`,
        )
          .bind(recording.id, recording.household_id)
          .all<{ surface: string; normalized: string; new_override: 'auto' | 'force_new' | 'force_not_new' }>()
      : await c.env.DB.prepare('SELECT surface, normalized, ? AS new_override FROM word_candidates WHERE recording_id = ? ORDER BY normalized')
          .bind('auto', recording.id)
          .all<{ surface: string; normalized: string; new_override: 'auto' | 'force_new' | 'force_not_new' }>();
  const status = recording.analysis_status === 'ready' ? '確認待ちです。内容を確認してください。' : recording.analysis_status === 'failed' ? '処理に失敗しました。手動入力または再試行が必要です。' : '処理中です。少し待つと自動で更新されます。';
  const candidateList = editableWords.results.map((candidate) => `<li>${escapeHtml(candidate.surface)}（${escapeHtml(candidate.normalized)}）</li>`).join('') || '<li>候補はまだありません。</li>';
  const editable = ['ready', 'partial', 'failed'].includes(recording.analysis_status);
  const wordControls =
    editableWords.results
      .map(
        (word, index) =>
          `<fieldset data-review-word><label>表記<input data-word-display value="${escapeHtml(word.surface)}" maxlength="100" required></label><label>よみ<input data-word-normalized value="${escapeHtml(word.normalized)}" maxlength="100" required></label><label>NEW表示<select data-word-override aria-label="${index + 1}件目のNEW表示"><option value="auto"${word.new_override === 'auto' ? ' selected' : ''}>自動</option><option value="force_new"${word.new_override === 'force_new' ? ' selected' : ''}>常に表示</option><option value="force_not_new"${word.new_override === 'force_not_new' ? ' selected' : ''}>表示しない</option></select></label></fieldset>`,
      )
      .join('') || '<p>単語候補はありません。必要なら下の追加欄へ入力してください。</p>';
  const editor = editable
    ? `<h2>確認・承認</h2><p id="save-status" aria-live="polite"></p><form id="review-form" data-recording-id="${recording.id}" data-version="${recording.version}"><label>文字起こし<textarea name="reviewed_text" maxlength="2000">${escapeHtml(transcript?.reviewed_text ?? transcript?.raw_text ?? '')}</textarea></label><h3>単語とNEW表示</h3><div id="word-inputs">${wordControls}</div><label>単語を追加（1行につき 表記|よみ）<textarea name="additional_words" maxlength="6030"></textarea></label><label>録音日時（UTC）<input name="captured_at" value="${escapeHtml(recording.captured_at)}" maxlength="24" required></label><label>タイムゾーン<input name="captured_timezone" value="${escapeHtml(recording.captured_timezone)}" maxlength="64" required></label><label>場面<textarea name="scene" maxlength="300">${escapeHtml(recording.draft_scene)}</textarea></label><label>親メモ<textarea name="parent_note" maxlength="2000">${escapeHtml(recording.draft_parent_note)}</textarea></label><button type="button" data-action="save">下書きを保存</button><button type="button" data-action="approve">承認する</button></form><script src="/assets/review-detail.js"></script>`
    : '<p>処理中は編集・承認できません。状態は自動的に更新されます。</p>';
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Echoes — 録音</title></head><body><main><p><a href="/">確認待ち一覧へ戻る</a> · <a href="/dictionary">ことば辞典</a></p><h1>録音の確認</h1><p><strong>状態:</strong> ${escapeHtml(recording.analysis_status)}</p><p>${status}</p><p><strong>録音日時:</strong> ${escapeHtml(recording.captured_at)} (${escapeHtml(recording.captured_timezone)})</p><audio controls preload="metadata" src="/api/v1/recordings/${recording.id}/audio">このブラウザでは音声を再生できません。</audio><h2>文字起こし（モック）</h2><p>${escapeHtml(transcript?.reviewed_text ?? transcript?.raw_text ?? 'まだありません。')}</p><h2>単語候補（モック）</h2><ul>${candidateList}</ul>${editor}</main></body></html>`);
});

app.get('/assets/review.js', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const script = `fetch('/api/v1/review-queue').then(r=>{if(!r.ok)throw new Error('request failed');return r.json()}).then(data=>{const list=document.getElementById('recordings');document.getElementById('status').textContent=data.items.length?'確認待ちの録音です。':'確認待ちの録音はありません。';for(const item of data.items){const recording=item.recording;if(!/^rec_[a-z0-9]{32}$/.test(recording.recording_id))continue;const li=document.createElement('li');const link=document.createElement('a');link.href='/recordings/'+encodeURIComponent(recording.recording_id);link.textContent=recording.captured_at+' — '+recording.analysis_status;li.append(link);list.append(li)}const failed=data.failed_deletions||[];for(const target of failed){if(!/^rec_[a-z0-9]{32}$/.test(target.recording_id))continue;const li=document.createElement('li');li.textContent='削除に失敗した録音（'+target.captured_at+'）: ';const button=document.createElement('button');button.type='button';button.textContent='削除を再試行';button.addEventListener('click',()=>{button.disabled=true;fetch('/api/v1/recordings/'+encodeURIComponent(target.recording_id),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:target.version})}).then(r=>{if(!r.ok)throw new Error('delete failed');location.reload()}).catch(()=>{button.disabled=false;document.getElementById('status').textContent='削除の再試行に失敗しました。時間をおいて再度お試しください。'})});li.append(button);list.append(li)}}).catch(()=>{document.getElementById('status').textContent='読み込みに失敗しました。再読み込みしてください。'});`;
  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      [CORRELATION_ID_HEADER]: c.get('correlationId'),
    },
  });
});

app.get('/assets/review-detail.js', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const script = `(()=>{const form=document.getElementById('review-form');if(!form)return;const status=document.getElementById('save-status');const field=name=>form.elements.namedItem(name);const buttons=form.querySelectorAll('button');const submit=async action=>{const words=[];for(const row of form.querySelectorAll('[data-review-word]')){const display=row.querySelector('[data-word-display]').value.trim();const normalized=row.querySelector('[data-word-normalized]').value.trim();const override=row.querySelector('[data-word-override]').value;if(!display||!normalized){status.textContent='候補の表記とよみを入力してください。';return}words.push({display_name:display,normalized,new_override:override})}const lines=String(field('additional_words').value).split('\\n').map(line=>line.trim()).filter(Boolean);for(const line of lines){const parts=line.split('|');if(parts.length!==2||!parts[0].trim()||!parts[1].trim()){status.textContent='追加単語は「表記|よみ」の形式で入力してください。';return}words.push({display_name:parts[0].trim(),normalized:parts[1].trim(),new_override:'auto'})}if(words.length>30||new Set(words.map(word=>word.normalized.normalize('NFKC').trim().toLocaleLowerCase('ja-JP'))).size!==words.length){status.textContent='単語は30件以内で、同じよみを重複登録できません。';return}const body={version:Number(form.dataset.version),reviewed_text:String(field('reviewed_text').value),words,captured_at:String(field('captured_at').value),captured_timezone:String(field('captured_timezone').value),scene:String(field('scene').value),parent_note:String(field('parent_note').value)};buttons.forEach(button=>button.disabled=true);status.textContent=action==='approve'?'承認を保存しています。':'下書きを保存しています。';try{const response=await fetch('/api/v1/recordings/'+encodeURIComponent(form.dataset.recordingId)+'/'+(action==='approve'?'approve':'review'),{method:action==='approve'?'POST':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(error&&error.message?error.message:'保存に失敗しました。')}status.textContent=action==='approve'?'承認しました。':'下書きを保存しました。';location.reload()}catch(error){status.textContent=error instanceof Error?error.message:'保存に失敗しました。'}finally{buttons.forEach(button=>button.disabled=false)}};form.addEventListener('click',event=>{const target=event.target;if(!(target instanceof HTMLButtonElement))return;const action=target.dataset.action;if(action==='save'||action==='approve'){event.preventDefault();void submit(action)}})})();`;
  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      [CORRELATION_ID_HEADER]: c.get('correlationId'),
    },
  });
});
