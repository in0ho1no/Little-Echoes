import { Hono } from 'hono';
import { html } from 'hono/html';

import { authenticateDevice, authenticateManagement } from './auth';
import { verifyAccessJwt } from './access-jwt';
import { reserveDeleteJob } from './delete';
import { reconcileGenerationDispatch } from './diary';
import { dispatchImageCleanup } from './image-cleanup';
import { CORRELATION_ID_HEADER, errorBody, newCorrelationId } from './errors';
import {
  ANALYSIS_STALE_MILLISECONDS,
  isDemoWriteAllowed,
  MAX_IMAGE_GENERATIONS_PER_RECORDING,
  MAX_IMAGE_GENERATIONS_PER_UTC_DAY,
  MAX_NON_IMAGE_AI_REQUESTS_PER_UTC_DAY,
  normalizeUtcRfc3339,
  retentionDeleteAfter,
  UPLOAD_RESERVED_STALE_MILLISECONDS,
  utcDay,
} from './limits';
import { approveReview, isVersionConflictAbort, saveReview, type ReviewInput, type ReviewTarget } from './review';
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
  diary_status: string;
  image_status: string;
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
  manual_retry: number;
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
  const retryAnalysisPath = /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/retry-analysis$/;
  const dictionaryPath = /^\/api\/v1\/dictionary\/word_[a-z0-9]{32}$/;
  const diaryPath = /^\/api\/v1\/diary\/diary_[a-z0-9]{32}$/;
  const diaryImagePath = /^\/api\/v1\/diary\/diary_[a-z0-9]{32}\/image$/;
  if (host === env.INGEST_HOST) {
    return (
      (method === 'POST' && path === '/api/v1/recordings') ||
      (method === 'POST' && /^\/api\/v1\/recordings\/rec_[a-z0-9]{32}\/process$/.test(path)) ||
      (method === 'GET' && recordingPath.test(path))
    );
  }
  if (host === env.ADMIN_HOST) {
    if (method === 'DELETE') return recordingPath.test(path) || diaryImagePath.test(path);
    if (method === 'PATCH') return reviewPath.test(path) || diaryPath.test(path);
    if (method === 'POST') return approvalPath.test(path) || retryAnalysisPath.test(path) || /^\/api\/v1\/diary\/diary_[a-z0-9]{32}\/(regenerate|image)$/.test(path);
    return (
      method === 'GET' &&
      (path === '/' ||
        path === '/dictionary' || path === '/diary' ||
        /^\/dictionary\/word_[a-z0-9]{32}$/.test(path) ||
        path === '/assets/review.js' || path === '/assets/diary.js' || path === '/assets/diary.css' || path === '/assets/review-remove.js' ||
        path === '/assets/review-detail.js' ||
        path === '/api/v1/review-queue' ||
        path === '/api/v1/dictionary' || path === '/api/v1/diary' || diaryPath.test(path) || diaryImagePath.test(path) || /^\/diary\/diary_[a-z0-9]{32}$/.test(path) ||
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
  const escaped = html`${value ?? ''}`;
  if (escaped instanceof Promise) throw new TypeError('文字列のHTMLエスケープが同期完了しませんでした。');
  return escaped.toString();
}

type NavKey = 'review' | 'diary' | 'dictionary';

// 全管理画面で同じ head・ヘッダーを共有する。スタイルは CSP(default-src 'self')の
// 制約下でインラインを使えないため、既存許可経路の /assets/diary.css だけから読み込む。
function pageShell(title: string, activeNav: NavKey, main: string, scripts = ''): string {
  const nav = (key: NavKey, href: string, label: string): string =>
    `<a href="${href}"${key === activeNav ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/assets/diary.css"></head><body><header class="masthead"><a class="brand" href="/">Little Echoes</a><nav class="site-nav" aria-label="主要ページ">${nav('review', '/', '確認待ち')}${nav('diary', '/diary', '絵日記')}${nav('dictionary', '/dictionary', 'ことば辞典')}</nav></header>${main}${scripts}</body></html>`;
}

function analysisStatusView(status: string, reviewStatus: string): { label: string; chip: string } {
  if (reviewStatus === 'approved') return { label: '承認済み', chip: 'chip-ok' };
  if (status === 'ready') return { label: '確認待ち', chip: 'chip-ok' };
  if (status === 'partial') return { label: '一部のみ自動取得', chip: 'chip-quiet' };
  if (status === 'failed') return { label: '自動解析に失敗', chip: 'chip-alert' };
  if (status === 'transcribing') return { label: '文字起こし中', chip: 'chip-quiet' };
  if (status === 'extracting_words') return { label: 'ことば抽出中', chip: 'chip-quiet' };
  return { label: '受付済み', chip: 'chip-quiet' };
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
    `SELECT r.id, r.household_id, r.source_id, r.audio_sha256, r.audio_object_key, r.analysis_status, r.diary_status, r.image_status,
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
    `SELECT r.id, r.household_id, r.source_id, r.audio_sha256, r.audio_object_key, r.analysis_status, r.diary_status, r.image_status,
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
    'SELECT id, status, correlation_id, last_error_code, updated_at, manual_retry FROM async_jobs WHERE recording_id = ? AND job_type = ? ORDER BY operation_number DESC LIMIT 1',
  )
    .bind(recordingIdValue, 'analysis')
    .first<JobRow>();
}

function safeAnalysisReason(code: string | null | undefined): string {
  if (code === 'EMPTY_TRANSCRIPT') return '文字起こし結果が空でした。音声を確認して手動で補完できます。';
  if (code === 'EMPTY_WORD_CANDIDATES') return '単語候補を抽出できませんでした。必要な単語を手動で追加できます。';
  if (code === 'COST_LIMIT_REACHED') return '本日のデモ上限に達しました。';
  if (code === 'TRANSCRIPT_TOO_LONG') return '文字起こし結果が長すぎたため、自動解析を完了できませんでした。';
  if (code === 'AUDIO_NOT_AVAILABLE' || code === 'INVALID_AUDIO') return '保存音声を自動解析に利用できませんでした。';
  if (code === 'UPSTREAM_RATE_LIMIT' || code === 'UPSTREAM_UNAVAILABLE' || code === 'UPSTREAM_REJECTED' || code === 'UPSTREAM_RESULT_UNKNOWN') {
    return '自動解析サービスで問題が発生しました。';
  }
  return '自動解析を完了できませんでした。取得済みの内容を確認してください。';
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
      if ((converged.meta.changes ?? 0) === 0) {
        return responseError(c, 409, 'UPLOAD_IN_PROGRESS', '同じ録音を保存中です。', true, 'しばらく待ってから状態を確認してください。');
      }
    }
    const retry = await c.env.DB.prepare(
      'UPDATE recordings SET upload_status = ?, upload_attempt_count = upload_attempt_count + 1, updated_at = ? WHERE id = ? AND upload_status = ? AND upload_attempt_count < 3',
    )
      .bind('reserved', new Date().toISOString(), existing.id, 'failed')
      .run();
    if ((retry.meta.changes ?? 0) === 0 || !existing.audio_object_key) {
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
    if ((reserveAttempt.meta.changes ?? 0) === 0) throw new Error('upload attempt reservation failed');
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

type DispatchResult = 'dispatch_pending' | 'dispatched' | 'failed' | 'result_unknown' | 'unknown';

async function convergeAnalysisDispatchFailure(env: Env, id: string, errorCode: 'UPSTREAM_RESULT_UNKNOWN' | 'WORKFLOW_DISPATCH_FAILED'): Promise<boolean> {
  const failedAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE processing_attempts
          SET status = 'unknown', error_code = ?, retryable = 0, finished_at = ?
        WHERE job_id = ? AND processing_kind = 'analysis' AND status = 'running'`,
    ).bind(errorCode, failedAt, id),
    env.DB.prepare(
      `UPDATE async_jobs SET status = 'failed', last_error_code = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running')`,
    ).bind(errorCode, failedAt, failedAt, id),
    env.DB.prepare(
      `UPDATE recordings SET analysis_status = 'failed', updated_at = ?
        WHERE id = (SELECT recording_id FROM async_jobs WHERE id = ? AND status = 'failed' AND last_error_code = ?)
          AND household_id = (SELECT household_id FROM async_jobs WHERE id = ? AND status = 'failed' AND last_error_code = ?)
          AND review_status = 'pending' AND analysis_status IN ('pending', 'transcribing', 'extracting_words')
          AND NOT EXISTS (
            SELECT 1 FROM async_jobs newer
             WHERE newer.recording_id = recordings.id AND newer.id <> ?
               AND newer.job_type = 'analysis' AND newer.status IN ('dispatch_pending', 'dispatched', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM processing_attempts active
             WHERE active.id = recordings.active_attempt_id AND active.status = 'running'
          )`,
    ).bind(failedAt, id, errorCode, id, errorCode, id),
  ]);
  return (results[1]?.meta.changes ?? 0) >= 1;
}

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
        if (await convergeAnalysisDispatchFailure(env, id, 'WORKFLOW_DISPATCH_FAILED')) return 'failed';
        const job = await env.DB.prepare('SELECT status FROM async_jobs WHERE id = ?').bind(id).first<{ status: string }>();
        if (job?.status === 'succeeded') return 'dispatched';
        if (job?.status === 'failed') return 'failed';
        return 'unknown';
      }
      if (status === 'complete') {
        const job = await env.DB.prepare('SELECT status FROM async_jobs WHERE id = ?').bind(id).first<{ status: string }>();
        if (job?.status === 'succeeded') return 'dispatched';
        if (job?.status === 'failed') return 'failed';
        if (await convergeAnalysisDispatchFailure(env, id, 'UPSTREAM_RESULT_UNKNOWN')) return 'result_unknown';
        const settled = await env.DB.prepare('SELECT status FROM async_jobs WHERE id = ?').bind(id).first<{ status: string }>();
        if (settled?.status === 'succeeded') return 'dispatched';
        if (settled?.status === 'failed') return 'failed';
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
    if (dispatch === 'result_unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理結果を確認できなかったため安全側で終了しました。', false, '管理画面から状態を確認し、必要なら明示的に再試行してください。');
    if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', false, '管理画面から状態を確認し、必要なら明示的に再試行してください。');
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
      `INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number, correlation_id, authorization_token_id, created_at, updated_at)
       SELECT ?, ?, ?, 'analysis', 'dispatch_pending', 1, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM async_jobs WHERE recording_id = ? AND job_type = 'analysis')
          AND (SELECT COUNT(*) FROM processing_attempts WHERE recording_id = ? AND processing_kind = 'analysis') < 3
          AND NOT EXISTS (
            SELECT 1 FROM async_jobs WHERE recording_id = ? AND job_type = 'analysis'
              AND status IN ('dispatch_pending', 'dispatched', 'running')
          )`,
    )
      .bind(id, identity.householdId, recording.id, c.get('correlationId'), identity.id, now, now, recording.id, recording.id, recording.id)
      .run()
      .then((result) => {
        if ((result.meta.changes ?? 0) === 0) throw new Error('analysis job was not reserved');
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
      if (dispatch === 'result_unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理結果を確認できなかったため安全側で終了しました。', false, '管理画面から状態を確認し、必要なら明示的に再試行してください。');
      if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', false, '管理画面から状態を確認し、必要なら明示的に再試行してください。');
      return c.json(acceptedJobResponse(raced.id, dispatch, c.get('correlationId')), 202);
    }
    const exhausted = await c.env.DB.prepare('SELECT COUNT(*) AS attempt_count FROM processing_attempts WHERE recording_id = ? AND processing_kind = ?')
      .bind(recording.id, 'analysis')
      .first<{ attempt_count: number }>();
    if ((exhausted?.attempt_count ?? 0) >= 3) return responseError(c, 409, 'PROCESSING_ATTEMPT_LIMIT_REACHED', '解析の試行上限に達しました。', false, '手動で内容を入力してください。');
    const previous = await latestJob(c.env, recording.id);
    if (previous) return responseError(c, 409, 'RETRY_NOT_AVAILABLE', 'この録音の初回解析はすでに受け付け済みです。', false, '管理画面から状態を確認してください。');
    return responseError(c, 500, 'JOB_RESERVATION_FAILED', '処理の予約に失敗しました。', true, '状態を確認してから再試行してください。');
  }
  const dispatch = await ensureAnalysisWorkflow(c.env, id);
  if (dispatch === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理の受付結果を確認できません。', false, '状態を確認してから同じ要求を再送してください。');
  if (dispatch === 'result_unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理結果を確認できなかったため安全側で終了しました。', false, '管理画面から状態を確認し、必要なら明示的に再試行してください。');
  if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', false, '管理画面から状態を確認し、必要なら明示的に再試行してください。');
  return c.json(acceptedJobResponse(id, dispatch, c.get('correlationId')), 202);
});

app.post('/api/v1/recordings/:id/retry-analysis', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) {
    return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。', false, '手動入力で内容を補完してください。');
  }
  const contentLength = c.req.raw.headers.get('Content-Length');
  if (!contentLength || !/^[0-9]+$/.test(contentLength) || Number(contentLength) > 128 || !c.req.raw.headers.get('Content-Type')?.startsWith('application/json')) {
    return responseError(c, 422, 'INVALID_RETRY_INPUT', '再解析要求が不正です。');
  }
  let body: unknown;
  try {
    body = await c.req.raw.json();
  } catch {
    return responseError(c, 422, 'INVALID_RETRY_INPUT', '再解析要求が不正です。');
  }
  const version = typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && 'version' in body ? (body as { version?: unknown }).version : null;
  if (!Number.isSafeInteger(version) || typeof version !== 'number' || version < 1) {
    return responseError(c, 422, 'INVALID_RETRY_INPUT', '再解析要求が不正です。');
  }
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const previousRetry = await latestJob(c.env, recording.id);
  if (previousRetry?.manual_retry === 1) {
    if (['dispatch_pending', 'dispatched', 'running'].includes(previousRetry.status)) {
      const dispatch = previousRetry.status === 'dispatch_pending' ? await ensureAnalysisWorkflow(c.env, previousRetry.id) : previousRetry.status;
      if (dispatch === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理の受付結果を確認できません。', false, '同じ再試行ボタンで受付状態を再確認してください。');
      if (dispatch === 'result_unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理結果を確認できなかったため安全側で終了しました。', false, '手動入力で内容を補完してください。');
      if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', false, '手動入力で内容を補完してください。');
      return c.json(acceptedJobResponse(previousRetry.id, dispatch, previousRetry.correlation_id), 202);
    }
    return responseError(c, 409, 'RETRY_NOT_AVAILABLE', '明示的な再解析はすでに使用済みです。', false, '手動入力で内容を補完してください。');
  }
  if (recording.version !== version) return responseError(c, 409, 'VERSION_CONFLICT', '録音は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
  if (recording.review_status !== 'pending' || !['partial', 'failed'].includes(recording.analysis_status)) {
    return responseError(c, 409, 'RETRY_NOT_AVAILABLE', 'この録音は再解析できません。', false, '手動入力で内容を補完してください。');
  }
  const attempts = await c.env.DB.prepare('SELECT COUNT(*) AS attempt_count FROM processing_attempts WHERE recording_id = ? AND processing_kind = ?')
    .bind(recording.id, 'analysis')
    .first<{ attempt_count: number }>();
  if ((attempts?.attempt_count ?? 0) >= 3) {
    return responseError(c, 409, 'PROCESSING_ATTEMPT_LIMIT_REACHED', '解析の試行上限に達しました。', false, '手動入力で内容を補完してください。');
  }
  const now = new Date().toISOString();
  const token = await c.env.DB.prepare(
    `SELECT id FROM device_tokens
      WHERE household_id = ? AND source_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY id ASC LIMIT 1`,
  )
    .bind(recording.household_id, recording.source_id, now)
    .first<{ id: string }>();
  if (!token) return responseError(c, 409, 'RETRY_NOT_AVAILABLE', '有効なデバイストークンがありません。', false, '手動入力で内容を補完してください。');
  const id = jobId();
  try {
    const reserved = await c.env.DB.prepare(
      `INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number, correlation_id, authorization_token_id, manual_retry, created_at, updated_at)
       SELECT ?, ?, ?, 'analysis', 'dispatch_pending', COALESCE(MAX(operation_number) + 1, 1), ?, ?, 1, ?, ?
         FROM async_jobs
        WHERE recording_id = ? AND job_type = 'analysis'
       HAVING COUNT(*) >= 0
          AND (SELECT COUNT(*) FROM processing_attempts WHERE recording_id = ? AND processing_kind = 'analysis') < 3
          AND NOT EXISTS (SELECT 1 FROM async_jobs WHERE recording_id = ? AND job_type = 'analysis' AND status IN ('dispatch_pending', 'dispatched', 'running'))
          AND EXISTS (SELECT 1 FROM recordings WHERE id = ? AND household_id = ? AND version = ? AND review_status = 'pending' AND analysis_status IN ('partial', 'failed'))`,
    )
      .bind(id, identity.householdId, recording.id, c.get('correlationId'), token.id, now, now, recording.id, recording.id, recording.id, recording.id, identity.householdId, version)
      .run();
    if ((reserved.meta.changes ?? 0) === 0) throw new Error('analysis retry was not reserved');
  } catch {
    const existing = await c.env.DB.prepare(
      `SELECT id, status, correlation_id, last_error_code, updated_at, manual_retry FROM async_jobs
        WHERE recording_id = ? AND job_type = 'analysis' AND manual_retry = 1 AND status IN ('dispatch_pending', 'dispatched', 'running')`,
    )
      .bind(recording.id)
      .first<JobRow>();
    if (existing) {
      const dispatch = existing.status === 'dispatch_pending' ? await ensureAnalysisWorkflow(c.env, existing.id) : existing.status;
      if (dispatch === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理の受付結果を確認できません。', false, '状態を確認してから明示的に再試行してください。');
      if (dispatch === 'result_unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理結果を確認できなかったため安全側で終了しました。', false, '手動入力で内容を補完してください。');
      if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', false, '手動入力で内容を補完してください。');
      return c.json(acceptedJobResponse(existing.id, dispatch, c.get('correlationId')), 202);
    }
    return responseError(c, 409, 'RETRY_NOT_AVAILABLE', '再解析を予約できません。', false, '手動入力で内容を補完してください。');
  }
  const dispatch = await ensureAnalysisWorkflow(c.env, id);
  if (dispatch === 'unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理の受付結果を確認できません。', false, '状態を確認してから明示的に再試行してください。');
  if (dispatch === 'result_unknown') return responseError(c, 500, 'UPSTREAM_RESULT_UNKNOWN', '処理結果を確認できなかったため安全側で終了しました。', false, '手動入力で内容を補完してください。');
  if (dispatch === 'failed') return responseError(c, 500, 'WORKFLOW_DISPATCH_FAILED', '処理の受付に失敗しました。', false, '手動入力で内容を補完してください。');
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
      else if (dispatch === 'result_unknown') {
        job = { ...job, status: 'failed', last_error_code: 'UPSTREAM_RESULT_UNKNOWN' };
        const refreshed =
          'sourceId' in identity ? await findDeviceRecording(c.env, identity, recording.id) : await findManagementRecording(c.env, identity, recording.id);
        recording = refreshed ?? recording;
      }
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
  } else if (recording.analysis_status === 'partial') {
    body.error = errorBody(
      job?.correlation_id ?? c.get('correlationId'),
      job?.last_error_code ?? 'PROCESSING_FAILED',
      '一部の自動解析結果だけ取得できました。',
      false,
      '手動で内容を補完するか、上限内で再試行してください。',
    );
  } else if (job?.status === 'failed') {
    body.error = errorBody(job?.correlation_id ?? c.get('correlationId'), job?.last_error_code ?? 'PROCESSING_FAILED', '処理に失敗しました。', false, '手動入力または上限内の再試行を選択してください。');
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

function reviewedRecordingResponse(recording: RecordingRow, correlationId: string): Record<string, string | number> {
  return {
    recording_id: recording.id,
    analysis_status: recording.analysis_status,
    review_status: recording.review_status,
    version: recording.version,
    correlation_id: correlationId,
  };
}

function reviewResultError(c: { json: (body: unknown, status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 429 | 500) => Response; get: (key: 'correlationId') => string }, result: 'version_conflict' | 'not_reviewable'): Response {
  if (result === 'version_conflict') return responseError(c, 409, 'VERSION_CONFLICT', '録音は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
  return responseError(c, 409, 'REVIEW_NOT_AVAILABLE', '処理中または削除中の録音は確認できません。', false, '処理完了後に再度確認してください。');
}

export async function ensureInitialDiaryGeneration(env: Env, householdId: string, recordingId: string, correlationId: string): Promise<void> {
  try {
    const diaryId = await env.DB.prepare(
      `SELECT d.id FROM diary_entries d JOIN recordings r ON r.id = d.recording_id
        WHERE d.recording_id = ? AND r.household_id = ? AND r.review_status = 'approved' AND r.diary_status = 'not_started'`,
    ).bind(recordingId, householdId).first<{ id: string }>();
    const diary = diaryId ? await findDiary(env, householdId, diaryId.id) : null;
    if (!diary || diary.diary_status !== 'not_started') return;
    const diaryJob = await reserveDiaryJob(env, diary, householdId, correlationId, 'diary');
    if (diaryJob) await dispatchDiaryWorkflow(env, diaryJob, 'diary');
  } catch {
    // 承認は確定済みのため応答を失敗させない。欠落した初回日記jobはcronのensureMissingInitialDiaryJobsが補償する。
  }
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
  if (saved.review_status === 'approved' && saved.diary_status === 'not_started') {
    await ensureInitialDiaryGeneration(c.env, identity.householdId, recording.id, c.get('correlationId'));
  }
  return c.json(reviewedRecordingResponse(saved, c.get('correlationId')), 200);
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
  if (approved.diary_status === 'not_started') {
    await ensureInitialDiaryGeneration(c.env, identity.householdId, recording.id, c.get('correlationId'));
  }
  return c.json(reviewedRecordingResponse(approved, c.get('correlationId')), 200);
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

interface DiaryRow {
  id: string;
  household_id: string;
  recording_id: string;
  diary_text: string | null;
  scene: string | null;
  version: number;
  recording_version: number;
  diary_status: string;
  image_status: string;
  captured_at: string;
  last_generation_error: string | null;
  active_image_id: string | null;
  active_image_created_at: string | null;
}

interface GenerationUsageCounter {
  used: number;
  limit: number;
  remaining: number;
}

interface GenerationUsage {
  text_daily: GenerationUsageCounter;
  image_daily: GenerationUsageCounter;
  image_recording: GenerationUsageCounter;
  manual_diary_regeneration_used: boolean;
}

async function generationUsage(env: Env, recordingId: string): Promise<GenerationUsage> {
  const day = utcDay();
  const [counters, manualRegeneration] = await Promise.all([
    env.DB.prepare(
      `SELECT counter_key, used_count FROM usage_counters
        WHERE (counter_key = ? AND usage_day = ?)
           OR (counter_key = ? AND usage_day = ?)
           OR (counter_key = ? AND usage_day = 'lifetime')`,
    )
      .bind('demo-global:openai_non_image', day, 'demo-global:image_generation', day, `recording:${recordingId}:image`)
      .all<{ counter_key: string; used_count: number }>(),
    env.DB.prepare(
      `SELECT 1 AS used FROM async_jobs WHERE recording_id = ? AND job_type = 'diary' AND manual_retry = 1 LIMIT 1`,
    )
      .bind(recordingId)
      .first<{ used: number }>(),
  ]);
  const usedCount = (counterKey: string): number => counters.results.find((counter) => counter.counter_key === counterKey)?.used_count ?? 0;
  const counter = (used: number, limit: number): GenerationUsageCounter => ({ used, limit, remaining: Math.max(0, limit - used) });
  return {
    text_daily: counter(usedCount('demo-global:openai_non_image'), MAX_NON_IMAGE_AI_REQUESTS_PER_UTC_DAY),
    image_daily: counter(usedCount('demo-global:image_generation'), MAX_IMAGE_GENERATIONS_PER_UTC_DAY),
    image_recording: counter(usedCount(`recording:${recordingId}:image`), MAX_IMAGE_GENERATIONS_PER_RECORDING),
    manual_diary_regeneration_used: Boolean(manualRegeneration),
  };
}

async function diaryResponse(env: Env, row: DiaryRow, correlationId: string): Promise<Record<string, unknown>> {
  const words = await env.DB.prepare(
    `SELECT wo.surface FROM word_occurrences wo WHERE wo.recording_id = ? AND wo.household_id = ? AND (wo.new_override = 'force_new' OR (wo.new_override = 'auto' AND wo.is_first = 1)) ORDER BY wo.surface`,
  ).bind(row.recording_id, row.household_id).all<{ surface: string }>();
  return {
    diary_id: row.id, recording_id: row.recording_id, status: row.diary_status, image_status: row.image_status,
    captured_at: row.captured_at, new_words: words.results.map((word) => word.surface), audio_endpoint: `/api/v1/recordings/${row.recording_id}/audio`, scene: row.scene, diary_text: row.diary_text, active_image_id: row.active_image_id,
    image_endpoint: row.active_image_id ? `/api/v1/diary/${row.id}/image` : null,
    version: row.version, last_error_code: row.last_generation_error, correlation_id: correlationId,
  };
}

async function diaryDetailResponse(env: Env, row: DiaryRow, correlationId: string): Promise<Record<string, unknown>> {
  const [diary, usage] = await Promise.all([diaryResponse(env, row, correlationId), generationUsage(env, row.recording_id)]);
  return { ...diary, generation_usage: usage };
}

async function findDiary(env: Env, householdId: string, id: string): Promise<DiaryRow | null> {
  return env.DB.prepare(
    `SELECT d.id, r.household_id, d.recording_id, d.diary_text, d.scene, d.version, d.last_generation_error,
             r.diary_status, r.image_status, r.captured_at, r.version AS recording_version, i.id AS active_image_id, i.created_at AS active_image_created_at
       FROM diary_entries d JOIN recordings r ON r.id = d.recording_id
       LEFT JOIN diary_images i ON i.diary_entry_id = d.id AND i.is_active = 1 AND i.deleted_at IS NULL
      WHERE d.id = ? AND r.household_id = ? AND r.review_status = 'approved'`,
  ).bind(id, householdId).first<DiaryRow>();
}

async function parseSmallJson(request: Request, maximum: number): Promise<Record<string, unknown> | null> {
  const length = request.headers.get('Content-Length');
  if ((length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum)) || !request.headers.get('Content-Type')?.startsWith('application/json')) return null;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maximum) return null;
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
}

async function dispatchDiaryWorkflow(env: Env, id: string, kind: 'diary' | 'image'): Promise<'dispatched' | 'unknown'> {
  try {
    const binding = kind === 'diary' ? env.DIARY_WORKFLOW : env.IMAGE_WORKFLOW;
    await binding.create({ id, params: { async_job_id: id } });
    await env.DB.prepare(`UPDATE async_jobs SET status = 'dispatched', workflow_instance_id = ?, updated_at = ? WHERE id = ? AND status = 'dispatch_pending'`)
      .bind(id, new Date().toISOString(), id).run();
    return 'dispatched';
  } catch {
    try {
      const binding = kind === 'diary' ? env.DIARY_WORKFLOW : env.IMAGE_WORKFLOW;
      const observed = await (await binding.get(id)).status();
      if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(String(observed.status))) {
        await env.DB.prepare(`UPDATE async_jobs SET status = 'dispatched', workflow_instance_id = ?, updated_at = ? WHERE id = ? AND status = 'dispatch_pending'`)
          .bind(id, new Date().toISOString(), id).run();
        return 'dispatched';
      }
    } catch { /* status cannot prove dispatch; keep the durable reservation for reconciliation. */ }
    return 'unknown';
  }
}

async function reserveDiaryJob(env: Env, diary: DiaryRow, householdId: string, correlationId: string, kind: 'diary' | 'image', replaceImageId?: string, manualRetry = false): Promise<string | null> {
  const id = jobId(); const now = new Date().toISOString();
  try {
    const result = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO async_jobs (id, household_id, recording_id, job_type, status, operation_number, correlation_id, manual_retry, expected_recording_version, expected_diary_version, created_at, updated_at)
         SELECT ?, ?, ?, ?, 'dispatch_pending', COALESCE(MAX(operation_number)+1, 1), ?, ?, ?, ?, ?, ? FROM async_jobs
          WHERE recording_id = ? AND job_type = ?
         HAVING COUNT(*) >= 0
            AND NOT EXISTS (SELECT 1 FROM async_jobs a WHERE a.recording_id = ? AND a.job_type IN ('diary','image') AND a.status IN ('dispatch_pending','dispatched','running'))
            AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = ? AND r.household_id = ? AND r.review_status = 'approved' AND r.version = ?
              AND EXISTS (SELECT 1 FROM diary_entries d WHERE d.id = ? AND d.recording_id = r.id AND d.version = ?)
              AND (CASE WHEN ? = 'diary' THEN r.diary_status IN ('not_started','failed','ready') ELSE r.image_status IN ('not_requested','failed','ready') END)
              AND (? IS NULL OR EXISTS (SELECT 1 FROM diary_images i WHERE i.id = ? AND i.diary_entry_id = ? AND i.is_active = 1 AND i.deleted_at IS NULL)))`,
      ).bind(id, householdId, diary.recording_id, kind, correlationId, manualRetry ? 1 : 0, diary.recording_version, diary.version, now, now, diary.recording_id, kind, diary.recording_id, diary.recording_id, householdId, diary.recording_version, diary.id, diary.version, kind, replaceImageId ?? null, replaceImageId ?? null, diary.id),
      env.DB.prepare(kind === 'diary'
        ? `UPDATE recordings SET diary_status = 'generating', updated_at = ? WHERE id = ? AND household_id = ? AND version = ? AND EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status = 'dispatch_pending')`
        : `UPDATE recordings SET image_status = 'generating', updated_at = ? WHERE id = ? AND household_id = ? AND version = ? AND EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status = 'dispatch_pending')`)
        .bind(now, diary.recording_id, householdId, diary.recording_version, id),
    ]);
    return (result[0]?.meta.changes ?? 0) >= 1 && (result[1]?.meta.changes ?? 0) >= 1 ? id : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE|constraint/i.test(message)) return null;
    throw error;
  }
}

export async function ensureMissingInitialDiaryJobs(env: Env, limit = 10): Promise<void> {
  if (!isDemoWriteAllowed(env.DEMO_WRITE_ENABLED)) return;
  const rows = await env.DB.prepare(
    `SELECT d.id, r.household_id FROM diary_entries d JOIN recordings r ON r.id = d.recording_id
      WHERE r.review_status = 'approved' AND r.diary_status = 'not_started'
        AND NOT EXISTS (SELECT 1 FROM async_jobs j WHERE j.recording_id = r.id AND j.job_type = 'diary')
      ORDER BY r.updated_at ASC LIMIT ?`,
  ).bind(limit).all<{ id: string; household_id: string }>();
  for (const row of rows.results) {
    const diary = await findDiary(env, row.household_id, row.id);
    if (!diary || diary.diary_status !== 'not_started') continue;
    const correlationId = newCorrelationId();
    const diaryJob = await reserveDiaryJob(env, diary, row.household_id, correlationId, 'diary');
    if (diaryJob) await dispatchDiaryWorkflow(env, diaryJob, 'diary');
  }
}

async function generationQuota(env: Env, diary: DiaryRow, kind: 'diary' | 'image'): Promise<'available' | 'daily' | 'lifetime'> {
  const day = utcDay();
  const counter = await env.DB.prepare(
    `SELECT used_count FROM usage_counters WHERE counter_key = ? AND usage_day = ?`,
  ).bind(kind === 'diary' ? 'demo-global:openai_non_image' : 'demo-global:image_generation', day).first<{ used_count: number }>();
  if ((counter?.used_count ?? 0) >= (kind === 'diary' ? MAX_NON_IMAGE_AI_REQUESTS_PER_UTC_DAY : MAX_IMAGE_GENERATIONS_PER_UTC_DAY)) return 'daily';
  if (kind === 'image') {
    const lifetime = await env.DB.prepare(
      `SELECT used_count FROM usage_counters WHERE counter_key = ? AND usage_day = 'lifetime'`,
    ).bind(`recording:${diary.recording_id}:image`).first<{ used_count: number }>();
    if ((lifetime?.used_count ?? 0) >= MAX_IMAGE_GENERATIONS_PER_RECORDING) return 'lifetime';
  }
  return 'available';
}

app.get('/api/v1/diary', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  await reconcileGenerationDispatch(c.env, 10, undefined, identity.householdId);
  const limit = integerInRange(c.req.query('limit') ?? '20', 1, 100);
  if (limit === null) return responseError(c, 422, 'INVALID_LIMIT', '一覧件数が不正です。');
  const rows = await c.env.DB.prepare(
    `SELECT d.id, r.household_id, d.recording_id, d.diary_text, d.scene, d.version, d.last_generation_error, r.diary_status, r.image_status, r.captured_at, r.version AS recording_version,
            i.id AS active_image_id, i.created_at AS active_image_created_at
       FROM diary_entries d JOIN recordings r ON r.id = d.recording_id
       LEFT JOIN diary_images i ON i.diary_entry_id = d.id AND i.is_active = 1 AND i.deleted_at IS NULL
      WHERE r.household_id = ? AND r.review_status = 'approved' ORDER BY r.captured_at DESC, d.id DESC LIMIT ?`,
  ).bind(identity.householdId, limit).all<DiaryRow>();
  return c.json({ items: await Promise.all(rows.results.map((row) => diaryResponse(c.env, row, c.get('correlationId')))), correlation_id: c.get('correlationId') });
});

app.get('/api/v1/diary/:id', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  let diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  if (diary) {
    await reconcileGenerationDispatch(c.env, 1, diary.recording_id, identity.householdId);
    diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  }
  return diary ? c.json(await diaryDetailResponse(c.env, diary, c.get('correlationId'))) : responseError(c, 404, 'NOT_FOUND', '対象の日記は見つかりません。');
});

app.patch('/api/v1/diary/:id', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。', false, '読み取り専用で確認してください。');
  const body = await parseSmallJson(c.req.raw, 8_192);
  if (!body || Object.keys(body).length !== 2 || !Number.isSafeInteger(body.version) || typeof body.version !== 'number' || body.version < 1 || normalizedText(body.diary_text, 4000, true) === null) return responseError(c, 422, 'INVALID_DIARY_INPUT', '日記の内容を確認してください。');
  const text = normalizedText(body.diary_text, 4000, true) ?? '';
  const now = new Date().toISOString();
  const sentinel = () => c.env.DB.prepare(
    `INSERT INTO recording_tombstones (recording_id, household_id, review_status, deleted_at)
     SELECT NULL, NULL, NULL, NULL WHERE (SELECT changes()) = 0`,
  );
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE diary_entries SET diary_text = ?, model = NULL, prompt_version = NULL, last_generation_error = NULL, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM async_jobs j WHERE j.recording_id = diary_entries.recording_id AND j.job_type IN ('diary','image') AND j.status IN ('dispatch_pending','dispatched','running'))
            AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = diary_entries.recording_id AND r.household_id = ? AND r.review_status = 'approved')`,
      ).bind(text, now, c.req.param('id'), body.version, identity.householdId),
      sentinel(),
      c.env.DB.prepare(
        `UPDATE recordings SET diary_status = 'ready', updated_at = ? WHERE id = (SELECT recording_id FROM diary_entries WHERE id = ? AND version = ?)
          AND household_id = ? AND review_status = 'approved'
          AND NOT EXISTS (SELECT 1 FROM async_jobs j WHERE j.recording_id = recordings.id AND j.job_type IN ('diary','image') AND j.status IN ('dispatch_pending','dispatched','running'))`,
      ).bind(now, c.req.param('id'), body.version + 1, identity.householdId),
      sentinel(),
    ]);
  } catch (error) {
    if (isVersionConflictAbort(error)) return responseError(c, 409, 'VERSION_CONFLICT', '日記は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
    return responseError(c, 500, 'INTERNAL_ERROR', '日記を保存できません。', true, '時間をおいて再試行してください。');
  }
  const diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  return diary ? c.json(await diaryDetailResponse(c.env, diary, c.get('correlationId'))) : responseError(c, 500, 'RECORDING_STATE_UNAVAILABLE', '日記状態を取得できません。', true);
});

app.post('/api/v1/diary/:id/regenerate', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。');
  const body = await parseSmallJson(c.req.raw, 256);
  if (!body || Object.keys(body).length !== 1 || !Number.isSafeInteger(body.version) || typeof body.version !== 'number') return responseError(c, 422, 'INVALID_DIARY_INPUT', '再生成要求が不正です。');
  const diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  if (!diary) return responseError(c, 404, 'NOT_FOUND', '対象の日記は見つかりません。');
  if (diary.version !== body.version) return responseError(c, 409, 'VERSION_CONFLICT', '日記は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
  if (await generationQuota(c.env, diary, 'diary') === 'daily') return responseError(c, 429, 'COST_LIMIT_REACHED', '日記生成の本日の上限に達しました。', false, '手動で日記文を入力してください。');
  const id = await reserveDiaryJob(c.env, diary, identity.householdId, c.get('correlationId'), 'diary', undefined, true);
  if (!id) return responseError(c, 409, 'DIARY_GENERATION_NOT_AVAILABLE', '日記生成を開始できません。', false, '処理中でないことと上限を確認してください。');
  const dispatch = await dispatchDiaryWorkflow(c.env, id, 'diary');
  return dispatch === 'dispatched' ? c.json(acceptedJobResponse(id, 'dispatched', c.get('correlationId')), 202) : responseError(c, 500, 'WORKFLOW_DISPATCH_UNKNOWN', '日記生成の受付結果を確認できません。', false, '状態を確認してください。');
});

app.post('/api/v1/diary/:id/image', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) return responseError(c, 403, 'DEMO_WRITE_DISABLED', 'デモ書き込みは現在停止しています。');
  const body = await parseSmallJson(c.req.raw, 512);
  const replace = body?.replace_image_id;
  if (!body || !Object.keys(body).every((key) => key === 'version' || key === 'replace_image_id' || key === 'confirmed') || !Number.isSafeInteger(body.version) || typeof body.version !== 'number' || body.confirmed !== true || (replace !== undefined && (typeof replace !== 'string' || !/^image_[a-z0-9]{32}$/.test(replace)))) return responseError(c, 422, 'INVALID_IMAGE_INPUT', '画像生成要求が不正です。');
  const diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  if (!diary) return responseError(c, 404, 'NOT_FOUND', '対象の日記は見つかりません。');
  if (diary.version !== body.version) return responseError(c, 409, 'VERSION_CONFLICT', '日記は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
  if (!diary.diary_text) return responseError(c, 409, 'DIARY_NOT_READY', '日記文を先に入力または生成してください。');
  if (diary.active_image_id && replace !== diary.active_image_id) return c.json({ ...errorBody(c.get('correlationId'), 'IMAGE_REPLACEMENT_CONFIRMATION_REQUIRED', '新しい画像の保存成功時だけ既存画像を置き換えます。', false, '現在の画像を確認してから再度実行してください。'), current_image_id: diary.active_image_id, current_image_created_at: diary.active_image_created_at }, 409);
  const quota = await generationQuota(c.env, diary, 'image');
  if (quota === 'daily') return responseError(c, 429, 'COST_LIMIT_REACHED', '画像生成の本日の上限に達しました。', false, '翌日以降に再試行してください。');
  if (quota === 'lifetime') {
    const limited = await c.env.DB.prepare(`UPDATE recordings SET image_status = 'limit_reached', updated_at = ? WHERE id = ? AND household_id = ? AND version = ? AND review_status = 'approved' AND image_status <> 'generating'
      AND NOT EXISTS (SELECT 1 FROM async_jobs j WHERE j.recording_id = recordings.id AND j.job_type IN ('diary','image') AND j.status IN ('dispatch_pending','dispatched','running'))`)
      .bind(new Date().toISOString(), diary.recording_id, identity.householdId, diary.recording_version).run();
    if ((limited.meta.changes ?? 0) === 0) return responseError(c, 409, 'VERSION_CONFLICT', '日記は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
    return responseError(c, 409, 'COST_LIMIT_REACHED', 'この録音の画像生成上限に達しました。', false, '既存画像を利用してください。');
  }
  const id = await reserveDiaryJob(c.env, diary, identity.householdId, c.get('correlationId'), 'image', diary.active_image_id ?? undefined);
  if (!id) return responseError(c, 409, 'IMAGE_GENERATION_NOT_AVAILABLE', '画像生成を開始できません。', false, '処理中でないことと上限を確認してください。');
  const dispatch = await dispatchDiaryWorkflow(c.env, id, 'image');
  return dispatch === 'dispatched' ? c.json(acceptedJobResponse(id, 'dispatched', c.get('correlationId')), 202) : responseError(c, 500, 'WORKFLOW_DISPATCH_UNKNOWN', '画像生成の受付結果を確認できません。', false, '状態を確認してください。');
});

app.get('/api/v1/diary/:id/image', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  const row = await c.env.DB.prepare(
    `SELECT i.image_object_key FROM diary_images i JOIN diary_entries d ON d.id = i.diary_entry_id JOIN recordings r ON r.id = d.recording_id
      WHERE d.id = ? AND r.household_id = ? AND r.review_status = 'approved' AND i.is_active = 1 AND i.deleted_at IS NULL`,
  ).bind(c.req.param('id'), identity.householdId).first<{ image_object_key: string }>();
  if (!row) return responseError(c, 404, 'NOT_FOUND', '対象の画像は見つかりません。');
  const image = await c.env.PRIVATE_MEDIA.get(row.image_object_key);
  if (!image) return responseError(c, 404, 'NOT_FOUND', '対象の画像は見つかりません。');
  return new Response(image.body, { headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'inline; filename="diary.png"', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', [CORRELATION_ID_HEADER]: c.get('correlationId') } });
});

app.delete('/api/v1/diary/:id/image', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  const body = await parseSmallJson(c.req.raw, 256);
  if (!body || Object.keys(body).length !== 1 || !Number.isSafeInteger(body.version) || typeof body.version !== 'number') return responseError(c, 422, 'INVALID_IMAGE_INPUT', '画像削除要求が不正です。');
  const diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  if (!diary) return responseError(c, 404, 'NOT_FOUND', '対象の日記は見つかりません。');
  if (diary.version !== body.version) return responseError(c, 409, 'VERSION_CONFLICT', '日記は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
  if (!diary.active_image_id) return responseError(c, 404, 'NOT_FOUND', '対象の画像は見つかりません。');
  const now = new Date().toISOString();
  const cleanupId = jobId();
  const image = await c.env.DB.prepare('SELECT image_object_key FROM diary_images WHERE id = ? AND diary_entry_id = ? AND is_active = 1').bind(diary.active_image_id, diary.id).first<{ image_object_key: string }>();
  if (!image) return responseError(c, 404, 'NOT_FOUND', '対象の画像は見つかりません。');
  const sentinel = () => c.env.DB.prepare(`INSERT INTO recording_tombstones (recording_id, household_id, review_status, deleted_at) SELECT NULL, NULL, NULL, NULL WHERE (SELECT changes()) = 0`);
  try { await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE diary_images SET is_active = 0, deleted_at = ? WHERE id = ? AND diary_entry_id = ? AND is_active = 1
      AND NOT EXISTS (SELECT 1 FROM async_jobs j WHERE j.recording_id = ? AND j.job_type IN ('diary','image') AND j.status IN ('dispatch_pending','dispatched','running'))`).bind(now, diary.active_image_id, diary.id, diary.recording_id),
    sentinel(),
    c.env.DB.prepare(`UPDATE diary_entries SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?
      AND EXISTS (SELECT 1 FROM diary_images WHERE id = ? AND is_active = 0 AND deleted_at = ?)
      AND NOT EXISTS (SELECT 1 FROM async_jobs j WHERE j.recording_id = diary_entries.recording_id AND j.job_type IN ('diary','image') AND j.status IN ('dispatch_pending','dispatched','running'))`).bind(now, diary.id, diary.version, diary.active_image_id, now),
    sentinel(),
    c.env.DB.prepare(`UPDATE recordings SET image_status = 'not_requested', updated_at = ? WHERE id = ? AND household_id = ?
      AND EXISTS (SELECT 1 FROM diary_images WHERE id = ? AND is_active = 0 AND deleted_at = ?)
      AND NOT EXISTS (SELECT 1 FROM async_jobs j WHERE j.recording_id = recordings.id AND j.job_type IN ('diary','image') AND j.status IN ('dispatch_pending','dispatched','running'))`).bind(now, diary.recording_id, identity.householdId, diary.active_image_id, now),
    sentinel(),
    c.env.DB.prepare(`INSERT INTO image_cleanup_jobs (id, household_id, diary_image_id, image_object_key, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'dispatch_pending', ?, ? WHERE EXISTS (SELECT 1 FROM diary_images WHERE id = ? AND is_active = 0 AND deleted_at = ?)`)
      .bind(cleanupId, identity.householdId, diary.active_image_id, image.image_object_key, now, now, diary.active_image_id, now),
    sentinel(),
  ]); } catch (error) {
    if (isVersionConflictAbort(error)) return responseError(c, 409, 'VERSION_CONFLICT', '画像は別の操作で更新されています。', false, '一覧を再読み込みしてください。');
    return responseError(c, 500, 'INTERNAL_ERROR', '画像を削除できません。', true, '時間をおいて再試行してください。');
  }
  const dispatch = await dispatchImageCleanup(c.env, cleanupId);
  return dispatch === 'dispatched' ? c.json(acceptedJobResponse(cleanupId, 'dispatched', c.get('correlationId')), 202) : responseError(c, 500, 'WORKFLOW_DISPATCH_UNKNOWN', '画像削除の受付結果を確認できません。', false, '状態を確認してください。');
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
  return c.html(
    pageShell(
      'Little Echoes',
      'review',
      `<main><h1>確認待ちの録音</h1><p id="status" aria-live="polite">確認待ちの録音を読み込んでいます。</p><ul id="recordings"></ul></main>`,
      `<script src="/assets/review.js"></script>`,
    ),
  );
});

app.get('/diary', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  return c.html(
    pageShell(
      'Little Echoes — 絵日記',
      'diary',
      `<main><h1>絵日記</h1><p id="diary-status" aria-live="polite">絵日記を読み込んでいます。</p><ul id="diaries"></ul></main>`,
      `<script src="/assets/diary.js"></script>`,
    ),
  );
});

app.get('/diary/:id', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  let diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  if (!diary) return responseError(c, 404, 'NOT_FOUND', '対象の日記は見つかりません。');
  await reconcileGenerationDispatch(c.env, 1, diary.recording_id, identity.householdId);
  diary = await findDiary(c.env, identity.householdId, c.req.param('id'));
  if (!diary) return responseError(c, 404, 'NOT_FOUND', '対象の日記は見つかりません。');
  const [newWords, usage] = await Promise.all([
    c.env.DB.prepare(
      `SELECT wo.surface FROM word_occurrences wo JOIN dictionary_words dw ON dw.id = wo.dictionary_word_id AND dw.household_id = wo.household_id
        WHERE wo.recording_id = ? AND wo.household_id = ? AND (wo.new_override = 'force_new' OR (wo.new_override = 'auto' AND wo.is_first = 1)) ORDER BY dw.normalized`,
    ).bind(diary.recording_id, identity.householdId).all<{ surface: string }>(),
    generationUsage(c.env, diary.recording_id),
  ]);
  const words = newWords.results.length
    ? `<ul class="stamp-list">${newWords.results.map((word) => `<li><span class="stamp">NEW</span>${escapeHtml(word.surface)}</li>`).join('')}</ul>`
    : '<p class="page-meta">NEWの単語はありません。</p>';
  const image = diary.active_image_id ? `<img class="diary-image" src="/api/v1/diary/${diary.id}/image" alt="生成した絵日記イラスト">` : '<p class="page-meta">画像はまだありません。</p>';
  const busy = diary.diary_status === 'generating' || diary.image_status === 'generating';
  const writesEnabled = isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED);
  const textDailyAvailable = usage.text_daily.remaining > 0;
  const imageAvailable = usage.image_daily.remaining > 0 && usage.image_recording.remaining > 0 && diary.image_status !== 'limit_reached';
  const diaryButtons = writesEnabled && !busy
    ? `<button type="button" data-action="save-diary">手動で保存</button>${usage.manual_diary_regeneration_used ? '' : `<button type="button" data-action="regenerate-diary"${textDailyAvailable ? '' : ' disabled aria-describedby="quota-summary"'}>日記文を生成</button>`}`
    : '';
  const imageGenerateButton = writesEnabled && !busy
    ? `<button type="button" data-action="generate-image"${imageAvailable ? '' : ' disabled aria-describedby="quota-summary"'}>${diary.active_image_id ? '画像を再生成' : '画像を生成'}</button>`
    : '';
  const imageDeleteButton = diary.active_image_id && !busy ? '<button type="button" data-action="delete-image">画像を削除</button>' : '';
  const retryMessage = usage.manual_diary_regeneration_used ? '<p>日記文の再生成は使用済みです。必要な場合は手動で編集してください。</p>' : '';
  const imageLimitMessage = diary.image_status === 'limit_reached' ? '<p>この録音の画像生成上限に達しました。保存済み画像は引き続き表示できます。</p>' : '';
  const imageCreatedMessage = diary.active_image_created_at ? `<p class="page-meta">現在の画像の作成日時: ${escapeHtml(diary.active_image_created_at)}</p>` : '';
  const quotaSummary = `<section class="quota-card" aria-labelledby="quota-title"><h2 id="quota-title">生成できる回数</h2><ul id="quota-summary" class="plain-list"><li><strong>この録音の画像:</strong> 残り ${usage.image_recording.remaining}/${usage.image_recording.limit}回</li><li><strong>本日の画像:</strong> 残り ${usage.image_daily.remaining}/${usage.image_daily.limit}回</li><li><strong>本日のテキスト系AI:</strong> 残り ${usage.text_daily.remaining}/${usage.text_daily.limit}回</li></ul><p class="page-meta">本日の回数はUTC日単位です。テキスト系AIには文字起こし・単語抽出・日記文生成が含まれます。</p></section>`;
  const status = busy ? '生成中です。少し待つと更新されます。' : diary.last_generation_error ? '生成に失敗しました。手動入力または再試行できます。' : '';
  const replaceDialog = `<dialog id="replace-dialog" aria-labelledby="replace-dialog-title"><h2 id="replace-dialog-title">画像の置き換え</h2><p>新しい画像の生成に成功した場合だけ、現在の画像を置き換えます。</p><p id="replace-quota"><strong>この録音の残り生成回数 ${usage.image_recording.remaining}/${usage.image_recording.limit}回</strong><br>本日の画像生成は残り ${usage.image_daily.remaining}/${usage.image_daily.limit}回です。</p><img id="replace-thumb" class="diary-thumb" alt="現在の画像"><p id="replace-thumb-missing" hidden>現在の画像を表示できません。</p><p id="replace-created" class="page-meta"></p><p class="actions"><button type="button" id="replace-ok">置き換えを続ける</button> <button type="button" id="replace-cancel">やめる</button></p></dialog>`;
  return c.html(
    pageShell(
      'Little Echoes — 絵日記',
      'diary',
      `<main data-diary-id="${escapeHtml(diary.id)}" data-version="${diary.version}" data-active-image="${escapeHtml(diary.active_image_id)}" data-active-image-created="${escapeHtml(diary.active_image_created_at)}" data-image-recording-remaining="${usage.image_recording.remaining}" data-image-recording-limit="${usage.image_recording.limit}" data-image-daily-remaining="${usage.image_daily.remaining}" data-image-daily-limit="${usage.image_daily.limit}"><h1>絵日記</h1><p id="diary-status"${busy ? ' class="busy"' : ''} aria-live="polite">${escapeHtml(status)}</p><p class="page-meta">録音日時: ${escapeHtml(diary.captured_at)}</p>${quotaSummary}<audio controls preload="metadata" src="/api/v1/recordings/${escapeHtml(diary.recording_id)}/audio">このブラウザでは音声を再生できません。</audio><section><h2>NEWの単語</h2>${words}</section><label>日記文<textarea id="diary-text" maxlength="4000">${escapeHtml(diary.diary_text)}</textarea></label><p class="actions">${diaryButtons}</p>${retryMessage}<section><h2>イラスト</h2>${image}${imageCreatedMessage}<p class="actions">${imageGenerateButton}${imageDeleteButton}</p>${imageLimitMessage}</section>${replaceDialog}</main>`,
      `<script src="/assets/diary.js"></script>`,
    ),
  );
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
      .map((word) => `<li><a class="word-link" href="/dictionary/${encodeURIComponent(word.id)}">${escapeHtml(word.display_name)}<span class="count">${word.occurrence_count}件</span></a></li>`)
      .join('') || '<li>承認済みの単語はまだありません。</li>';
  return c.html(pageShell('Little Echoes — ことば辞典', 'dictionary', `<main><h1>ことば辞典</h1><ul class="card-list">${list}</ul></main>`));
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
          `<li>${isNewForDisplay(occurrence) ? '<strong class="stamp">NEW</strong> ' : ''}<span class="page-meta">${escapeHtml(occurrence.spoken_at)}</span><br>${escapeHtml(occurrence.utterance_text ?? '')} <a href="/recordings/${encodeURIComponent(occurrence.recording_id)}">録音を開く</a></li>`,
      )
      .join('') || '<li>発話履歴はありません。</li>';
  return c.html(
    pageShell(
      `Little Echoes — ${escapeHtml(word.display_name)}`,
      'dictionary',
      `<main><h1>${escapeHtml(word.display_name)}</h1><p class="page-meta">記録回数: ${word.occurrence_count}回</p><h2>発話履歴</h2><ul class="card-list">${list}</ul></main>`,
    ),
  );
});

app.get('/recordings/:id', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const recording = await findManagementRecording(c.env, identity, c.req.param('id'));
  if (!recording || !['pending', 'approved'].includes(recording.review_status)) return responseError(c, 404, 'NOT_FOUND', '対象の録音は見つかりません。');
  const transcript = await c.env.DB.prepare('SELECT raw_text, reviewed_text FROM transcripts WHERE recording_id = ?').bind(recording.id).first<{ raw_text: string | null; reviewed_text: string | null }>();
  // 呼び出し代入の変数をテンプレートへ直接補間しない — XSS監査(unknown-value-with-script-tag)は
  // 「関数戻り値の変数が、scriptタグを含む呼び出し引数内で使われる」形を検出する。実防御は
  // 従来どおりescapeHtmlで、ここでは非呼び出しの??連結へ束ねた値だけを補間に使う。
  const transcriptText = transcript?.reviewed_text ?? transcript?.raw_text;
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
  let canRetry = false;
  let retryReason = '';
  let analysisReason = '';
  if (['partial', 'failed'].includes(recording.analysis_status)) {
    const [attempts, token, job] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) AS attempt_count FROM processing_attempts WHERE recording_id = ? AND processing_kind = ?')
        .bind(recording.id, 'analysis').first<{ attempt_count: number }>(),
      c.env.DB.prepare('SELECT id FROM device_tokens WHERE household_id = ? AND source_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY id ASC LIMIT 1')
        .bind(recording.household_id, recording.source_id, new Date().toISOString()).first<{ id: string }>(),
      latestJob(c.env, recording.id),
    ]);
    const activeJob = job && ['dispatch_pending', 'dispatched', 'running'].includes(job.status);
    analysisReason = safeAnalysisReason(job?.last_error_code);
    canRetry = isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED) && (attempts?.attempt_count ?? 0) < 3 && Boolean(token) && !activeJob && job?.manual_retry !== 1;
    if (canRetry) retryReason = '自動解析をもう一度だけ明示的に試せます。';
    else if (!isDemoWriteAllowed(c.env.DEMO_WRITE_ENABLED)) retryReason = '現在は再解析を利用できません。手動で内容を補完してください。';
    else if ((attempts?.attempt_count ?? 0) >= 3) retryReason = '解析の試行上限に達しました。手動で内容を補完してください。';
    else if (!token) retryReason = '有効な入力端末がないため再解析できません。手動で内容を補完してください。';
    else if (activeJob) retryReason = '再解析を処理中です。完了までお待ちください。';
    else if (job?.manual_retry === 1) retryReason = '明示的な再解析は使用済みです。手動で内容を補完してください。';
    else retryReason = '再解析を利用できません。手動で内容を補完してください。';
    retryReason = `${analysisReason} ${retryReason}`;
  }
  const status = recording.review_status === 'approved'
    ? '承認済みです。必要に応じて内容を編集できます。'
    : ['ready', 'partial'].includes(recording.analysis_status)
      ? '確認待ちです。内容を確認・補完してください。'
      : recording.analysis_status === 'failed'
        ? '処理に失敗しました。手動入力または再試行が必要です。'
        : '処理中です。少し待つと自動で更新されます。';
  const candidateList = editableWords.results.map((candidate) => `<li>${escapeHtml(candidate.surface)}（${escapeHtml(candidate.normalized)}）</li>`).join('') || '<li>候補はまだありません。</li>';
  const editable = ['ready', 'partial', 'failed'].includes(recording.analysis_status);
  const wordControls =
    editableWords.results
      .map(
        (word, index) =>
           `<fieldset data-review-word><label>表記<input data-word-display value="${escapeHtml(word.surface)}" maxlength="100" required></label><label>よみ<input data-word-normalized value="${escapeHtml(word.normalized)}" maxlength="100" required></label><label>NEW表示<select data-word-override aria-label="${index + 1}件目のNEW表示"><option value="auto"${word.new_override === 'auto' ? ' selected' : ''}>自動</option><option value="force_new"${word.new_override === 'force_new' ? ' selected' : ''}>常に表示</option><option value="force_not_new"${word.new_override === 'force_not_new' ? ' selected' : ''}>表示しない</option></select></label><button type="button" data-remove-word>候補を削除</button></fieldset>`,
      )
      .join('') || '<p>単語候補はありません。必要なら下の追加欄へ入力してください。</p>';
  const retryButton = retryReason
    ? `<p id="retry-reason">${escapeHtml(retryReason)}</p>${canRetry ? '<button type="button" id="retry-analysis">自動解析を再試行</button>' : ''}`
    : '';
  const approved = recording.review_status === 'approved';
  const editorTitle = approved ? '承認内容の編集' : '確認・承認';
  const saveDraftButton = approved ? '' : '<button type="button" data-action="save">下書きを保存</button>';
  const approveLabel = approved ? '変更を保存' : '承認する';
  const editor = editable
    ? `<h2>${editorTitle}</h2><p id="save-status" aria-live="polite"></p>${retryButton}<form id="review-form" data-recording-id="${recording.id}" data-version="${recording.version}" data-approved="${approved}"><label>文字起こし<textarea name="reviewed_text" maxlength="2000">${escapeHtml(transcriptText ?? '')}</textarea></label><h3>単語とNEW表示</h3><div id="word-inputs">${wordControls}</div><label>単語を追加（1行につき 表記|よみ）<textarea name="additional_words" maxlength="6030"></textarea></label><label>録音日時（UTC）<input name="captured_at" value="${escapeHtml(recording.captured_at)}" maxlength="24" required></label><label>タイムゾーン<input name="captured_timezone" value="${escapeHtml(recording.captured_timezone)}" maxlength="64" required></label><label>場面<textarea name="scene" maxlength="300">${escapeHtml(recording.draft_scene)}</textarea></label><label>親メモ<textarea name="parent_note" maxlength="2000">${escapeHtml(recording.draft_parent_note)}</textarea></label><p class="actions">${saveDraftButton}<button type="button" data-action="approve">${approveLabel}</button></p></form>`
    : '<p>処理中は編集・承認できません。状態は自動的に更新されます。</p>';
  const statusView = analysisStatusView(recording.analysis_status, recording.review_status);
  // pageShellの呼び出し引数にscriptタグ文字列と関数戻り値の補間を同居させない — XSS監査
  // (unknown-value-with-script-tag)は「scriptタグを含む呼び出し引数内の未知値」を検出する。
  // 実防御は従来どおりescapeHtmlで、ここでは束ねた変数だけを呼び出しへ渡す。
  const detailMain = `<main data-recording-id="${recording.id}"><h1>録音の確認</h1><p class="status-line"><span class="chip ${statusView.chip}">${statusView.label}</span></p><p id="processing-status">${status}</p><p class="page-meta">録音日時: ${escapeHtml(recording.captured_at)}（${escapeHtml(recording.captured_timezone)}）</p><audio controls preload="metadata" src="/api/v1/recordings/${recording.id}/audio">このブラウザでは音声を再生できません。</audio><h2>文字起こし</h2><p class="transcript">${escapeHtml(transcriptText ?? 'まだありません。')}</p><h2>単語候補</h2><ul class="plain-list">${candidateList}</ul>${editor}</main>`;
  const detailScripts = '<script src="/assets/review-detail.js"></script><script src="/assets/review-remove.js"></script>';
  return c.html(pageShell('Little Echoes — 録音', 'review', detailMain, detailScripts));
});

app.get('/assets/review.js', async (c) => {
  const identity = await managementIdentity(c);
  if (isResponse(identity)) return identity;
  const script = `fetch('/api/v1/review-queue').then(r=>{if(!r.ok)throw new Error('request failed');return r.json()}).then(data=>{const list=document.getElementById('recordings');document.getElementById('status').textContent=data.items.length?'確認待ちの録音です。':'確認待ちの録音はありません。';for(const item of data.items){const recording=item.recording;if(!/^rec_[a-z0-9]{32}$/.test(recording.recording_id))continue;const li=document.createElement('li');const link=document.createElement('a');link.href='/recordings/'+encodeURIComponent(recording.recording_id);link.textContent=recording.captured_at+' — '+({ready:'確認待ち',partial:'一部のみ自動取得',failed:'自動解析に失敗',transcribing:'文字起こし中',extracting_words:'ことば抽出中',pending:'受付済み'}[recording.analysis_status]||recording.analysis_status);li.append(link);list.append(li)}const failed=data.failed_deletions||[];for(const target of failed){if(!/^rec_[a-z0-9]{32}$/.test(target.recording_id))continue;const li=document.createElement('li');li.textContent='削除に失敗した録音（'+target.captured_at+'）: ';const button=document.createElement('button');button.type='button';button.textContent='削除を再試行';button.addEventListener('click',()=>{button.disabled=true;fetch('/api/v1/recordings/'+encodeURIComponent(target.recording_id),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:target.version})}).then(r=>{if(!r.ok)throw new Error('delete failed');location.reload()}).catch(()=>{button.disabled=false;document.getElementById('status').textContent='削除の再試行に失敗しました。時間をおいて再度お試しください。'})});li.append(button);list.append(li)}}).catch(()=>{document.getElementById('status').textContent='読み込みに失敗しました。再読み込みしてください。'});`;
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
  const script = `(()=>{const form=document.getElementById('review-form');if(!form){const page=document.querySelector('main[data-recording-id]');if(!page||!/^rec_[a-z0-9]{32}$/.test(page.dataset.recordingId||''))return;let remaining=180;const stalled=()=>{const el=document.getElementById('processing-status');if(el)el.textContent='更新が停止しました。ページを再読み込みしてください。'};const poll=()=>{if(remaining--<=0){stalled();return}fetch('/api/v1/recordings/'+encodeURIComponent(page.dataset.recordingId)).then(response=>{if(!response.ok)throw new Error('status failed');return response.json()}).then(data=>{if(['ready','partial','failed'].includes(data.analysis_status)){location.reload();return}setTimeout(poll,5000)}).catch(()=>setTimeout(poll,10000))};setTimeout(poll,5000);return}const status=document.getElementById('save-status');const field=name=>form.elements.namedItem(name);const buttons=form.querySelectorAll('button');const retry=document.getElementById('retry-analysis');const approved=form.dataset.approved==='true';const submit=async action=>{const words=[];for(const row of form.querySelectorAll('[data-review-word]')){const display=row.querySelector('[data-word-display]').value.trim();const normalized=row.querySelector('[data-word-normalized]').value.trim();const override=row.querySelector('[data-word-override]').value;if(!display||!normalized){status.textContent='候補の表記とよみを入力してください。';return}words.push({display_name:display,normalized,new_override:override})}const lines=String(field('additional_words').value).split('\\n').map(line=>line.trim()).filter(Boolean);for(const line of lines){const parts=line.split('|');if(parts.length!==2||!parts[0].trim()||!parts[1].trim()){status.textContent='追加単語は「表記|よみ」の形式で入力してください。';return}words.push({display_name:parts[0].trim(),normalized:parts[1].trim(),new_override:'auto'})}if(words.length>30||new Set(words.map(word=>word.normalized.normalize('NFKC').trim().toLocaleLowerCase('ja-JP'))).size!==words.length){status.textContent='単語は30件以内で、同じよみを重複登録できません。';return}const body={version:Number(form.dataset.version),reviewed_text:String(field('reviewed_text').value),words,captured_at:String(field('captured_at').value),captured_timezone:String(field('captured_timezone').value),scene:String(field('scene').value),parent_note:String(field('parent_note').value)};buttons.forEach(button=>button.disabled=true);status.textContent=action==='approve'?(approved?'変更を保存しています。':'承認を保存しています。'):'下書きを保存しています。';try{const response=await fetch('/api/v1/recordings/'+encodeURIComponent(form.dataset.recordingId)+'/'+(action==='approve'?'approve':'review'),{method:action==='approve'?'POST':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(error&&error.message?error.message:'保存に失敗しました。')}status.textContent=action==='approve'?(approved?'変更を保存しました。':'承認しました。'):'下書きを保存しました。';location.reload()}catch(error){status.textContent=error instanceof Error?error.message:'保存に失敗しました。'}finally{buttons.forEach(button=>button.disabled=false)}};if(retry)retry.addEventListener('click',()=>{retry.disabled=true;status.textContent='自動解析を再試行しています。';fetch('/api/v1/recordings/'+encodeURIComponent(form.dataset.recordingId)+'/retry-analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:Number(form.dataset.version)})}).then(async response=>{if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(error&&error.message?error.message:'再試行を開始できませんでした。')}location.reload()}).catch(error=>{status.textContent=error instanceof Error?error.message:'再試行を開始できませんでした。';retry.disabled=false})});form.addEventListener('click',event=>{const target=event.target;if(!(target instanceof HTMLButtonElement))return;const action=target.dataset.action;if(action==='save'||action==='approve'){event.preventDefault();void submit(action)}})})();`;
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

app.get('/assets/diary.css', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  const stylesheet = [
    // トークン: 紙・墨・クレヨン青・朱(スタンプ)。方眼はごく薄い青
    ':root{color-scheme:light;--paper:#F7F4EC;--card:#FFFDF8;--ink:#35312B;--muted:#756F64;--line:#E1DCCE;--grid:rgba(70,110,150,.10);--crayon:#3B6FA0;--crayon-deep:#2F5A84;--stamp:#C2402F}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:0 .9rem 3rem;background:var(--paper);color:var(--ink);font-family:"Hiragino Maru Gothic ProN","BIZ UDPGothic","Yu Gothic UI","Yu Gothic",system-ui,sans-serif;line-height:1.65;overflow-wrap:anywhere}',
    '.masthead{max-width:42rem;margin:0 auto;padding:1rem .2rem .6rem;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .9rem}',
    '.brand{font-weight:700;letter-spacing:.04em;font-size:1.05rem;color:var(--crayon-deep);text-decoration:none}',
    '.site-nav{display:flex;gap:.4rem;margin-left:auto}',
    '.site-nav a{padding:.3rem .8rem;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;font-size:.88rem}',
    '.site-nav a[aria-current="page"]{background:var(--crayon);border-color:var(--crayon);color:#fff}',
    // 方眼ノート紙面: 白カード上に24px方眼を敷き、入力欄・カードの白がその上に載る
    'main{max-width:42rem;margin:0 auto;padding:1.3rem 1.1rem 2rem;background-color:var(--card);background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:24px 24px;border:1px solid var(--line);border-radius:14px}',
    'h1{font-size:1.3rem;letter-spacing:.06em;margin:.2rem 0 1rem;padding-bottom:.35rem;border-bottom:3px double var(--crayon)}',
    'h2{font-size:1.02rem;letter-spacing:.04em;margin:1.6rem 0 .5rem}',
    'h3{font-size:.95rem;margin:1.2rem 0 .4rem}',
    'a{color:var(--crayon)}',
    'img{max-width:100%}',
    'audio{width:100%;margin:.4rem 0}',
    '.page-meta{color:var(--muted);font-size:.9rem;margin:.2rem 0}',
    '#status,#diary-status,#save-status,#processing-status,#retry-reason{font-size:.95rem}',
    '.status-line{margin:.3rem 0}',
    '.chip{display:inline-block;padding:.1rem .75rem;border-radius:999px;font-size:.85rem;border:1px solid}',
    '.chip-ok{color:var(--crayon-deep);border-color:var(--crayon);background:#EFF4F9}',
    '.chip-quiet{color:var(--muted);border-color:var(--line);background:#fff}',
    '.chip-alert{color:var(--stamp);border-color:var(--stamp);background:#FAEEEC}',
    // NEWことばスタンプ: 二重丸+朱色+わずかな傾きで、先生のはんこを模す
    '.stamp{display:inline-grid;place-items:center;min-width:2.3em;height:2.3em;margin-right:.45em;border:2px solid var(--stamp);border-radius:50%;box-shadow:inset 0 0 0 2px #fff,inset 0 0 0 3px var(--stamp);color:var(--stamp);font-size:.68rem;font-weight:700;letter-spacing:.03em;transform:rotate(-8deg);background:#FBF1EF}',
    '.stamp-list{list-style:none;padding:0;margin:.4rem 0;display:flex;flex-wrap:wrap;gap:.5rem 1rem}',
    '.stamp-list li{display:flex;align-items:center}',
    '#recordings,#diaries,.card-list{list-style:none;margin:.8rem 0 0;padding:0;display:grid;gap:.6rem}',
    '#recordings li,#diaries li,.card-list li{background:#fff;border:1px solid var(--line);border-radius:10px;padding:.85rem 1rem;box-shadow:0 1px 0 rgba(53,49,43,.05)}',
    '#recordings li>a,#diaries li>a{display:block;margin:-.85rem -1rem;padding:.85rem 1rem;color:var(--ink);text-decoration:none}',
    '#recordings li>a:hover,#diaries li>a:hover{color:var(--crayon-deep)}',
    '.word-link{display:flex;justify-content:space-between;align-items:baseline;gap:.6rem;margin:-.85rem -1rem;padding:.85rem 1rem;color:var(--ink);text-decoration:none;font-weight:700}',
    '.word-link:hover{color:var(--crayon-deep)}',
    '.count{color:var(--muted);font-size:.85rem;font-weight:400}',
    '.plain-list{margin:.4rem 0;padding-left:1.3rem}',
    '.transcript{background:#fff;border:1px solid var(--line);border-radius:10px;padding:.8rem 1rem;min-height:2.5rem}',
    '.quota-card{margin:1rem 0;padding:.75rem .9rem;background:#fff;border:1px solid var(--line);border-radius:10px}',
    '.quota-card h2{margin-top:0}',
    '.quota-card .plain-list{margin-bottom:.35rem}',
    'label{display:block;margin:.9rem 0;font-size:.9rem;font-weight:700}',
    'input,textarea,select{font:inherit;font-weight:400;width:100%;margin-top:.3rem;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}',
    'textarea{min-height:6rem;resize:vertical}',
    'fieldset[data-review-word]{border:1px solid var(--line);border-radius:10px;background:#fff;margin:.7rem 0;padding:.2rem .9rem .9rem}',
    'fieldset[data-review-word] label{margin:.55rem 0 0}',
    'button{font:inherit;font-size:.92rem;font-weight:700;padding:.5rem 1.1rem;border-radius:10px;border:1px solid var(--crayon);background:#fff;color:var(--crayon-deep);cursor:pointer;min-height:2.5rem}',
    'button:hover{background:#EFF4F9}',
    'button:disabled{opacity:.45;cursor:default}',
    '[data-action="approve"],[data-action="save-diary"]{background:var(--crayon);border-color:var(--crayon);color:#fff}',
    '[data-action="approve"]:hover,[data-action="save-diary"]:hover{background:var(--crayon-deep)}',
    '[data-action="delete-image"],[data-remove-word]{border-color:var(--stamp);color:var(--stamp)}',
    '[data-action="delete-image"]:hover,[data-remove-word]:hover{background:#FAEEEC}',
    '[data-remove-word]{margin-top:.7rem;font-size:.85rem;padding:.35rem .8rem;min-height:0}',
    '.actions{display:flex;flex-wrap:wrap;gap:.6rem;margin:.9rem 0}',
    'a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--crayon);outline-offset:2px}',
    'dialog{border:1px solid var(--line);border-radius:14px;padding:1.2rem;box-shadow:0 12px 32px rgba(53,49,43,.18)}',
    'dialog::backdrop{background:rgba(53,49,43,.35)}',
    '#replace-dialog{max-width:22rem}',
    '#replace-dialog h2{margin-top:0}',
    '@keyframes spin{to{transform:rotate(360deg)}}',
    '.busy::before{content:"";display:inline-block;width:1em;height:1em;margin-right:.5em;border:.18em solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-.15em;animation:spin .8s linear infinite}',
    '.busy[data-stage="2"]::before{animation-duration:.6s;border-width:.24em}',
    '.busy[data-stage="3"]::before{animation-duration:.45s;border-width:.3em}',
    '.busy[data-stage="4"]::before{animation-duration:.3s;border-width:.36em}',
    '.diary-image{max-width:100%;height:auto;border:1px solid var(--line);border-radius:10px;background:#fff;padding:6px}',
    '.diary-thumb{max-width:12rem;height:auto;display:block}',
    '@media(max-width:360px){body{padding:0 .45rem 2rem}.masthead{padding:.7rem 0 .45rem}.site-nav{width:100%;margin-left:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.25rem}.site-nav a{padding:.35rem .2rem;text-align:center;font-size:.78rem}main{padding:1rem .75rem 1.5rem;border-radius:10px}.actions>button{flex:1 1 8rem}dialog{width:calc(100% - 1rem);margin:auto}}',
    '@media(prefers-reduced-motion:reduce){.busy::before{animation:none}}',
  ].join('');
  return new Response(stylesheet, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', [CORRELATION_ID_HEADER]: c.get('correlationId') } });
});

app.get('/assets/diary.js', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  const script = `(()=>{
    const status=document.getElementById('diary-status');
    const page=document.querySelector('main[data-diary-id]');
    const fail=async r=>{const e=await r.json().catch(()=>null);throw new Error(e&&e.message?e.message:'操作に失敗しました。')};
    if(!page){
      fetch('/api/v1/diary').then(r=>r.ok?r.json():fail(r)).then(data=>{
        const list=document.getElementById('diaries');
        status.textContent=data.items.length?'絵日記です。':'承認済みの絵日記はまだありません。';
        for(const diary of data.items){
          const li=document.createElement('li'),a=document.createElement('a');
          a.href='/diary/'+encodeURIComponent(diary.diary_id);
          a.textContent=diary.captured_at+' — '+(diary.diary_text||({'generating':'生成中','failed':'生成失敗','not_started':'未作成'}[diary.status]||'日記'));
          li.append(a);list.append(li);
        }
      }).catch(e=>status.textContent=e.message);
      return;
    }
    const id=page.dataset.diaryId;
    const version=()=>Number(page.dataset.version);
    const imageQuotaMessage=()=>
      'この録音の残り生成回数 '+page.dataset.imageRecordingRemaining+'/'+page.dataset.imageRecordingLimit+'回。\\n'+
      '本日の画像生成は残り '+page.dataset.imageDailyRemaining+'/'+page.dataset.imageDailyLimit+'回です。';
    const post=async(path,method,body)=>{
      status.textContent='⏳ 処理を受け付けています…';
      const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!r.ok)await fail(r);
      location.reload();
    };
    let elapsed=0;
    const showProgress=()=>{
      const stage=Math.min(4,1+Math.floor(elapsed/30));
      status.classList.add('busy');status.dataset.stage=String(stage);
      status.textContent='生成中です（経過 '+elapsed+'秒・段階 '+stage+'/4）。少し待つと更新されます。';
    };
    let remaining=180;
    const poll=()=>{
      if(remaining--<=0){status.classList.remove('busy');status.removeAttribute('data-stage');status.textContent='更新が停止しました。ページを再読み込みしてください。';return}
      fetch('/api/v1/diary/'+encodeURIComponent(id)).then(r=>r.ok?r.json():null).then(data=>{
        if(data&&(data.status==='generating'||data.image_status==='generating')){elapsed+=5;showProgress();setTimeout(poll,5000)}
        else if(data)location.reload();
        else setTimeout(poll,10000);
      }).catch(()=>{elapsed+=10;showProgress();setTimeout(poll,10000)});
    };
    if(status.classList.contains('busy')){showProgress();setTimeout(poll,5000)}
    const dialog=document.getElementById('replace-dialog');
    const openReplaceDialog=(active,created,target)=>{
      const thumb=document.getElementById('replace-thumb');
      const missing=document.getElementById('replace-thumb-missing');
      missing.hidden=true;thumb.hidden=false;
      thumb.onerror=()=>{thumb.hidden=true;missing.hidden=false};
      document.getElementById('replace-created').textContent='作成日時: '+(created||'不明');
      document.getElementById('replace-ok').onclick=()=>{
        dialog.close();
        void post('/api/v1/diary/'+encodeURIComponent(id)+'/image','POST',{version:version(),confirmed:true,replace_image_id:active}).catch(e=>{status.textContent=e.message;target.disabled=false});
      };
      document.getElementById('replace-cancel').onclick=()=>{dialog.close();target.disabled=false};
      dialog.oncancel=()=>{target.disabled=false};
      thumb.src='/api/v1/diary/'+encodeURIComponent(id)+'/image';
      dialog.showModal();
    };
    page.addEventListener('click',event=>{
      const target=event.target;
      if(!(target instanceof HTMLButtonElement))return;
      const action=target.dataset.action;
      if(!action)return;
      target.disabled=true;
      if(action==='save-diary')void post('/api/v1/diary/'+encodeURIComponent(id),'PATCH',{version:version(),diary_text:String(document.getElementById('diary-text').value)}).catch(e=>{status.textContent=e.message;target.disabled=false});
      if(action==='regenerate-diary')void post('/api/v1/diary/'+encodeURIComponent(id)+'/regenerate','POST',{version:version()}).catch(e=>{status.textContent=e.message;target.disabled=false});
      if(action==='generate-image'){
        const active=page.dataset.activeImage;
        if(active){openReplaceDialog(active,page.dataset.activeImageCreated,target);return}
        if(!confirm('新しい画像を生成します。\\n'+imageQuotaMessage()+'\\n生成すると1回消費します。続けますか？')){target.disabled=false;return}
        void post('/api/v1/diary/'+encodeURIComponent(id)+'/image','POST',{version:version(),confirmed:true}).catch(e=>{status.textContent=e.message;target.disabled=false});
      }
      if(action==='delete-image'){
        if(!confirm('現在の画像を削除しますか？')){target.disabled=false;return}
        void post('/api/v1/diary/'+encodeURIComponent(id)+'/image','DELETE',{version:version()}).catch(e=>{status.textContent=e.message;target.disabled=false});
      }
    });
  })();`;
  return new Response(script, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', [CORRELATION_ID_HEADER]: c.get('correlationId') } });
});

app.get('/assets/review-remove.js', async (c) => {
  const identity = await managementIdentity(c); if (isResponse(identity)) return identity;
  const script = `document.addEventListener('click',event=>{const target=event.target;if(!(target instanceof HTMLButtonElement)||!target.hasAttribute('data-remove-word'))return;event.preventDefault();const row=target.closest('[data-review-word]');if(row&&confirm('この候補を確認対象から除外しますか？'))row.remove()});`;
  return new Response(script, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', [CORRELATION_ID_HEADER]: c.get('correlationId') } });
});
