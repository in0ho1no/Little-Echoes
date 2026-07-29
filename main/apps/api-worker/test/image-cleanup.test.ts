import { describe, expect, it } from 'vitest';

import { dispatchImageCleanup, runImageCleanup, sweepUnreferencedImageObjects } from '../src/image-cleanup';
import type { Env } from '../src/types';

function env(deleteImage: () => Promise<void>, changes = 1, dispatchReconcileCount = 0, sql: string[] = []): Env {
  const database = {
    prepare: (statement: string) => ({
      bind: (..._values: unknown[]) => ({
        first: async () => statement.includes('FROM image_cleanup_jobs') ? {
          id: 'job_cleanup',
          image_object_key: 'diary-images/image_old.png',
          status: 'dispatched',
          attempt_count: 0,
          dispatch_reconcile_count: dispatchReconcileCount,
          dispatch_lease_until: null,
        } : null,
        run: async () => { sql.push(statement); return { meta: { changes } }; },
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
  return {
    DB: database,
    PRIVATE_MEDIA: { delete: deleteImage } as unknown as R2Bucket,
    ANALYSIS_WORKFLOW: {} as Workflow<{ async_job_id: string }>, DELETE_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DIARY_WORKFLOW: {} as Workflow<{ async_job_id: string }>, IMAGE_WORKFLOW: {} as Workflow<{ async_job_id: string }>, IMAGE_CLEANUP_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64), DEMO_WRITE_ENABLED: 'true', ACCESS_TEAM_DOMAIN: 'team', ACCESS_AUD: 'aud', ADMIN_HOST: 'app', INGEST_HOST: 'ingest',
  } as Env;
}

describe('inactive image cleanup', () => {
  it('records success only after private R2 deletion', async () => {
    let deleted = false;
    await runImageCleanup(env(async () => { deleted = true; }), 'job_cleanup', async (_name, _limit, operation) => operation());
    expect(deleted).toBe(true);
  });

  it('records a retryable deletion failure and surfaces it to the bounded workflow step', async () => {
    await expect(runImageCleanup(env(async () => { throw new Error('R2 down'); }), 'job_cleanup', async (_name, _limit, operation) => operation())).rejects.toThrow('R2 down');
  });

  it('does not delete again after the three-attempt cap rejects the claim', async () => {
    let deleted = false;
    await runImageCleanup(env(async () => { deleted = true; }, 0), 'job_cleanup', async (_name, _limit, operation) => operation());
    expect(deleted).toBe(false);
  });

  it('isolates cleanup dispatch after the third unknown observation', async () => {
    const supplied = env(async () => undefined, 1, 2);
    supplied.IMAGE_CLEANUP_WORKFLOW = {
      create: async () => { throw new Error('duplicate terminal workflow'); },
      get: async () => ({ status: async () => ({ status: 'errored' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    await expect(dispatchImageCleanup(supplied, 'job_cleanup')).resolves.toBe('unknown');
  });

  it('does not regress a running cleanup back to dispatched', async () => {
    const statements: string[] = [];
    const supplied = env(async () => undefined, 1, 0, statements);
    supplied.IMAGE_CLEANUP_WORKFLOW = {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    await expect(dispatchImageCleanup(supplied, 'job_cleanup')).resolves.toBe('dispatched');
    expect(statements.some((sql) => sql.includes("CASE WHEN status = 'dispatch_pending' THEN 'dispatched' ELSE status END"))).toBe(true);
  });

  it('sweeps only unreferenced day-old image objects', async () => {
    const dayOld = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 60 * 60 * 1000);
    const referencedKey = `diary-images/image_${'a'.repeat(32)}.png`;
    const orphanKey = `diary-images/image_${'b'.repeat(32)}.png`;
    const freshKey = `diary-images/image_${'c'.repeat(32)}.png`;
    const deleted: string[] = [];
    const referenceSql: string[] = [];
    const supplied = env(async () => undefined);
    supplied.DB = {
      prepare: (statement: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            referenceSql.push(statement);
            return values[0] === referencedKey ? { present: 1 } : null;
          },
        }),
      }),
    } as unknown as D1Database;
    supplied.PRIVATE_MEDIA = {
      list: async () => ({ objects: [
        { key: referencedKey, uploaded: dayOld },
        { key: orphanKey, uploaded: dayOld },
        { key: freshKey, uploaded: fresh },
        { key: 'diary-images/unrelated.txt', uploaded: dayOld },
      ] }),
      delete: async (key: string) => { deleted.push(key); },
    } as unknown as R2Bucket;
    await sweepUnreferencedImageObjects(supplied);
    expect(deleted).toEqual([orphanKey]);
    expect(referenceSql.every((sql) => sql.includes('deleted_at IS NULL') && sql.includes("status IN ('dispatch_pending','dispatched','running')"))).toBe(true);
    expect(referenceSql).toHaveLength(2);
  });
});
