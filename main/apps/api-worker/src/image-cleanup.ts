import { WorkflowEntrypoint } from 'cloudflare:workers';

import type { Env, WorkflowParams } from './types';

type RunStep = (name: string, retryLimit: number, operation: () => Promise<void>) => Promise<void>;

interface CleanupJob {
  id: string;
  image_object_key: string;
  status: string;
  attempt_count: number;
  dispatch_reconcile_count: number;
  dispatch_lease_until: string | null;
}

async function load(env: Env, id: string): Promise<CleanupJob | null> {
  return env.DB.prepare(
    `SELECT id, image_object_key, status, attempt_count, dispatch_reconcile_count, dispatch_lease_until
       FROM image_cleanup_jobs WHERE id = ?`,
  ).bind(id).first<CleanupJob>();
}

export async function dispatchImageCleanup(env: Env, id: string): Promise<'dispatched' | 'unknown'> {
  const job = await load(env, id);
  if (!job || ['succeeded', 'failed'].includes(job.status) || job.dispatch_reconcile_count >= 3) return 'unknown';
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
export async function sweepUnreferencedImageObjects(env: Env, limit = 20): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let listed: { objects: { key: string; uploaded: Date }[] };
  try {
    listed = await env.PRIVATE_MEDIA.list({ prefix: 'diary-images/', limit: 200 });
  } catch {
    return;
  }
  let deleted = 0;
  for (const object of listed.objects) {
    if (deleted >= limit) return;
    if (object.uploaded.getTime() > cutoff) continue;
    const match = /^diary-images\/image_([a-z0-9]{32})\.png$/.exec(object.key);
    if (!match) continue;
    let referenced: { present: number } | null;
    try {
      referenced = await env.DB.prepare(
        `SELECT 1 AS present WHERE EXISTS (SELECT 1 FROM diary_images WHERE image_object_key = ? AND deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM async_jobs WHERE id = ? AND status IN ('dispatch_pending','dispatched','running'))`,
      ).bind(object.key, `job_${match[1]}`).first<{ present: number }>();
    } catch {
      return;
    }
    if (referenced) continue;
    try {
      await env.PRIVATE_MEDIA.delete(object.key);
      deleted += 1;
    } catch { /* 失敗分は翌日のスイープが同じ条件で回収する。 */ }
  }
}

export class ImageCleanupWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: { payload: WorkflowParams }, step: { do: (name: string, options: unknown, operation: () => Promise<void>) => Promise<void> }): Promise<void> {
    await runImageCleanup(this.env, event.payload.async_job_id, (name, retryLimit, operation) => step.do(name, { retries: { limit: retryLimit, delay: '1 second', backoff: 'constant' } }, operation));
  }
}
