import { describe, expect, it } from 'vitest';

import { dispatchImageCleanup, runImageCleanup, sweepUnreferencedImageObjects } from '../src/image-cleanup';
import type { Env } from '../src/types';

function env(deleteImage: () => Promise<void>, changes = 1, dispatchReconcileCount = 0, sql: string[] = [], createdAt?: string): Env {
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
          created_at: createdAt ?? new Date().toISOString(),
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

  it('terminates an image cleanup job that exceeds the absolute deadline', async () => {
    const statements: string[] = [];
    let terminated = 0;
    const supplied = env(async () => undefined, 1, 0, statements, '2020-01-01T00:00:00.000Z');
    supplied.IMAGE_CLEANUP_WORKFLOW = {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'running' }), terminate: async () => { terminated += 1; } }),
    } as unknown as Workflow<{ async_job_id: string }>;
    await expect(dispatchImageCleanup(supplied, 'job_cleanup')).resolves.toBe('unknown');
    expect(terminated).toBe(1);
    expect(statements.some((sql) => sql.includes("last_error_code = 'CLEANUP_DEADLINE_EXCEEDED'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('SET dispatch_lease_until = ?'))).toBe(false);
  });

  it('sweeps only unreferenced day-old image objects', async () => {
    const dayOld = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 60 * 60 * 1000);
    const referencedKey = `diary-images/image_${'a'.repeat(32)}.png`;
    const activeJobKey = `diary-images/image_${'d'.repeat(32)}.png`;
    const orphanKey = `diary-images/image_${'b'.repeat(32)}.png`;
    const freshKey = `diary-images/image_${'c'.repeat(32)}.png`;
    const deleted: unknown[] = [];
    const sqlLog: string[] = [];
    const supplied = env(async () => undefined);
    supplied.DB = {
      prepare: (statement: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => { sqlLog.push(statement); return null; },
          run: async () => { sqlLog.push(statement); return { meta: { changes: 1 } }; },
          all: async () => {
            sqlLog.push(statement);
            if (statement.includes('FROM diary_images')) return { results: [{ key: referencedKey }] };
            if (statement.includes('FROM async_jobs')) return { results: [{ id: `job_${'d'.repeat(32)}` }] };
            return { results: [] };
          },
        }),
      }),
    } as unknown as D1Database;
    supplied.PRIVATE_MEDIA = {
      list: async () => ({ truncated: false, objects: [
        { key: referencedKey, uploaded: dayOld },
        { key: activeJobKey, uploaded: dayOld },
        { key: orphanKey, uploaded: dayOld },
        { key: freshKey, uploaded: fresh },
        { key: 'diary-images/unrelated.txt', uploaded: dayOld },
      ] }),
      delete: async (keys: unknown) => { deleted.push(keys); },
    } as unknown as R2Bucket;
    await sweepUnreferencedImageObjects(supplied);
    expect(deleted).toEqual([[orphanKey]]);
    expect(sqlLog.some((sql) => sql.includes('FROM diary_images') && sql.includes('deleted_at IS NULL'))).toBe(true);
    expect(sqlLog.some((sql) => sql.includes('FROM async_jobs') && sql.includes("status IN ('dispatch_pending','dispatched','running')"))).toBe(true);
  });

  it('advances the sweep cursor across pages so later orphans are reachable', async () => {
    const dayOld = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const lastKey = `diary-images/image_${'e'.repeat(32)}.png`;
    const cursorWrites: unknown[][] = [];
    const listCalls: { startAfter?: string }[] = [];
    const supplied = env(async () => undefined);
    supplied.DB = {
      prepare: (statement: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => statement.includes('FROM r2_sweep_cursors') ? { start_after: 'diary-images/image_previous.png' } : null,
          run: async () => {
            if (statement.includes('INSERT INTO r2_sweep_cursors')) cursorWrites.push(values);
            return { meta: { changes: 1 } };
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database;
    supplied.PRIVATE_MEDIA = {
      list: async (options: { startAfter?: string }) => {
        listCalls.push(options);
        return { truncated: true, objects: [{ key: lastKey, uploaded: dayOld }] };
      },
      delete: async () => undefined,
    } as unknown as R2Bucket;
    await sweepUnreferencedImageObjects(supplied);
    expect(listCalls[0]?.startAfter).toBe('diary-images/image_previous.png');
    expect(cursorWrites[0]?.[1]).toBe(lastKey);
  });
});
