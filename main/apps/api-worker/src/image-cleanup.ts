import { WorkflowEntrypoint } from 'cloudflare:workers';

import { GENERATION_DEADLINE_MILLISECONDS } from './limits';
import type { Env, WorkflowParams } from './types';

type RunStep = (name: string, retryLimit: number, operation: () => Promise<void>) => Promise<void>;

interface CleanupJob {
  id: string;
  image_object_key: string;
  status: string;
  attempt_count: number;
  dispatch_reconcile_count: number;
  dispatch_lease_until: string | null;
  created_at: string;
}

async function load(env: Env, id: string): Promise<CleanupJob | null> {
  return env.DB.prepare(
    `SELECT id, image_object_key, status, attempt_count, dispatch_reconcile_count, dispatch_lease_until, created_at
       FROM image_cleanup_jobs WHERE id = ?`,
  ).bind(id).first<CleanupJob>();
}

const ACTIVE_CLEANUP_WORKFLOW_STATUSES = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'];

export async function dispatchImageCleanup(env: Env, id: string): Promise<'dispatched' | 'unknown'> {
  const job = await load(env, id);
  if (!job || ['succeeded', 'failed'].includes(job.status) || job.dispatch_reconcile_count >= 3) return 'unknown';
  // 活性観測のたびのカウンタ延命を絶対期限で打ち切る。終端後の遅延書き込みはstatus guardで
  // 着地せず、削除し損ねたR2オブジェクトは日次スイープが回収する。
  const deadlineBefore = new Date(Date.now() - GENERATION_DEADLINE_MILLISECONDS).toISOString();
  if (job.created_at <= deadlineBefore) {
    try {
      const instance = await env.IMAGE_CLEANUP_WORKFLOW.get(id);
      if (ACTIVE_CLEANUP_WORKFLOW_STATUSES.includes(String((await instance.status()).status))) await instance.terminate();
    } catch { /* 終了・観測に失敗しても収束を優先する。 */ }
    const failedAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE image_cleanup_jobs SET status = 'failed', dispatch_reconcile_count = 3,
      dispatch_lease_until = NULL, last_error_code = 'CLEANUP_DEADLINE_EXCEEDED', finished_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('dispatch_pending','dispatched','running')`).bind(failedAt, failedAt, id).run();
    return 'unknown';
  }
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 60 * 1000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE image_cleanup_jobs SET dispatch_lease_until = ? WHERE id = ?
      AND status IN ('dispatch_pending','dispatched','running') AND dispatch_reconcile_count = ?
      AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?)`,
  ).bind(leaseUntil, id, job.dispatch_reconcile_count, now.toISOString()).run();
  if ((claimed.meta.changes ?? 0) !== 1) return 'unknown';
  try {
    await env.IMAGE_CLEANUP_WORKFLOW.create({ id, params: { async_job_id: id } });
    await env.DB.prepare(`UPDATE image_cleanup_jobs SET status = CASE WHEN status = 'dispatch_pending' THEN 'dispatched' ELSE status END, dispatch_reconcile_count = 0,
      dispatch_lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('dispatch_pending','dispatched','running')
      AND dispatch_lease_until = ?`).bind(new Date().toISOString(), id, leaseUntil).run();
    return 'dispatched';
  } catch {
    try {
      const observed = await (await env.IMAGE_CLEANUP_WORKFLOW.get(id)).status();
      if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(String(observed.status))) {
        await env.DB.prepare(`UPDATE image_cleanup_jobs SET status = CASE WHEN status = 'dispatch_pending' THEN 'dispatched' ELSE status END, dispatch_reconcile_count = 0,
          dispatch_lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('dispatch_pending','dispatched','running')
          AND dispatch_lease_until = ?`).bind(new Date().toISOString(), id, leaseUntil).run();
        return 'dispatched';
      }
    } catch { /* the durable pending state is retained for a bounded later retry. */ }
    const failedAt = new Date().toISOString();
    if (job.dispatch_reconcile_count >= 2) {
      await env.DB.prepare(`UPDATE image_cleanup_jobs SET status = 'failed', dispatch_reconcile_count = 3,
        dispatch_lease_until = NULL, last_error_code = 'WORKFLOW_DISPATCH_UNKNOWN', finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('dispatch_pending','dispatched','running') AND dispatch_reconcile_count = ?
        AND dispatch_lease_until = ?`).bind(failedAt, failedAt, id, job.dispatch_reconcile_count, leaseUntil).run();
    } else {
      await env.DB.prepare(`UPDATE image_cleanup_jobs SET status = 'dispatch_pending',
        dispatch_reconcile_count = dispatch_reconcile_count + 1, dispatch_lease_until = NULL,
        last_error_code = 'WORKFLOW_DISPATCH_UNKNOWN', updated_at = ?
        WHERE id = ? AND status IN ('dispatch_pending','dispatched','running') AND dispatch_reconcile_count = ?
        AND dispatch_lease_until = ?`).bind(failedAt, id, job.dispatch_reconcile_count, leaseUntil).run();
    }
    return 'unknown';
  }
}

export async function runImageCleanup(env: Env, id: string, runStep: RunStep): Promise<void> {
  const job = await load(env, id);
  if (!job || ['succeeded', 'failed'].includes(job.status)) return;
  await runStep('delete-inactive-image', 3, async () => {
    const now = new Date().toISOString();
    const claimed = await env.DB.prepare(
      `UPDATE image_cleanup_jobs SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND status IN ('dispatch_pending','dispatched','running') AND attempt_count < 3`,
    ).bind(now, id).run();
    if ((claimed.meta.changes ?? 0) !== 1) return;
    try {
      await env.PRIVATE_MEDIA.delete(job.image_object_key);
      await env.DB.prepare(`UPDATE image_cleanup_jobs SET status = 'succeeded', last_error_code = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
        .bind(now, now, id).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'R2_DELETE_FAILED';
      await env.DB.prepare(`UPDATE image_cleanup_jobs SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'dispatched' END, last_error_code = 'R2_DELETE_FAILED', updated_at = ? WHERE id = ? AND status = 'running'`)
        .bind(new Date().toISOString(), id).run();
      throw new Error(message);
    }
  });
}

export async function scheduleImageCleanup(env: Env, limit = 10): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const jobs = await env.DB.prepare(
    `SELECT id FROM image_cleanup_jobs WHERE status IN ('dispatch_pending','dispatched','running')
      AND attempt_count < 3 AND dispatch_reconcile_count < 3 AND updated_at <= ?
      AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?) ORDER BY updated_at ASC LIMIT ?`,
  ).bind(staleBefore, now.toISOString(), limit).all<{ id: string }>();
  for (const job of jobs.results) await dispatchImageCleanup(env, job.id);
}

// purge後に遅延着地した画像put（所有ジョブ行が既に削除済み）は他の収束機構から不可視になるため、
// R2の実在オブジェクトを起点にした日次スイープだけが回収できる。24時間未満のオブジェクトには
// 触れない — 実行中生成の「R2保存済み・D1未コミット」窓を誤削除しないための猶予。
// 1回のスイープは1ページだけ処理し、D1へ永続化したカーソルで翌日以降に後続ページへ進む
// （R2一覧は辞書順のため、先頭固定では後続の孤児へ到達できない）。参照確認は一括2クエリ、
// 削除は一括1要求とし、Workers Freeのsubrequest上限内に収める。
const SWEEP_PREFIX = 'diary-images/';
const SWEEP_PAGE_SIZE = 50;

export async function sweepUnreferencedImageObjects(env: Env): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let startAfter: string | undefined;
  try {
    const cursor = await env.DB.prepare(`SELECT start_after FROM r2_sweep_cursors WHERE prefix = ?`)
      .bind(SWEEP_PREFIX).first<{ start_after: string | null }>();
    startAfter = cursor?.start_after ?? undefined;
  } catch {
    return;
  }
  let listed: { objects: { key: string; uploaded: Date }[]; truncated: boolean };
  try {
    listed = await env.PRIVATE_MEDIA.list({ prefix: SWEEP_PREFIX, limit: SWEEP_PAGE_SIZE, startAfter });
  } catch {
    return;
  }
  const candidates: { key: string; jobId: string }[] = [];
  for (const object of listed.objects) {
    const match = /^diary-images\/image_([a-z0-9]{32})\.png$/.exec(object.key);
    if (!match || object.uploaded.getTime() > cutoff) continue;
    candidates.push({ key: object.key, jobId: `job_${match[1]}` });
  }
  if (candidates.length > 0) {
    const placeholders = candidates.map(() => '?').join(',');
    let liveImages: { results: { key: string }[] };
    let liveJobs: { results: { id: string }[] };
    try {
      liveImages = await env.DB.prepare(
        `SELECT image_object_key AS key FROM diary_images WHERE deleted_at IS NULL AND image_object_key IN (${placeholders})`,
      ).bind(...candidates.map((candidate) => candidate.key)).all<{ key: string }>();
      liveJobs = await env.DB.prepare(
        `SELECT id FROM async_jobs WHERE status IN ('dispatch_pending','dispatched','running') AND id IN (${placeholders})`,
      ).bind(...candidates.map((candidate) => candidate.jobId)).all<{ id: string }>();
    } catch {
      return;
    }
    const referencedKeys = new Set(liveImages.results.map((row) => row.key));
    const referencedJobs = new Set(liveJobs.results.map((row) => row.id));
    const doomed = candidates
      .filter((candidate) => !referencedKeys.has(candidate.key) && !referencedJobs.has(candidate.jobId))
      .map((candidate) => candidate.key);
    if (doomed.length > 0) {
      try {
        await env.PRIVATE_MEDIA.delete(doomed);
      } catch {
        return; /* カーソルを進めず、翌日のスイープが同じページを再処理する。 */
      }
    }
  }
  const nextStartAfter = listed.truncated ? listed.objects.at(-1)?.key ?? null : null;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO r2_sweep_cursors (prefix, start_after, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(prefix) DO UPDATE SET start_after = excluded.start_after, updated_at = excluded.updated_at`,
    ).bind(SWEEP_PREFIX, nextStartAfter, now).run();
  } catch { /* カーソル未更新は再処理になるだけで安全側。 */ }
}

export class ImageCleanupWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: { payload: WorkflowParams }, step: { do: (name: string, options: unknown, operation: () => Promise<void>) => Promise<void> }): Promise<void> {
    await runImageCleanup(this.env, event.payload.async_job_id, (name, retryLimit, operation) => step.do(name, { retries: { limit: retryLimit, delay: '1 second', backoff: 'constant' } }, operation));
  }
}
