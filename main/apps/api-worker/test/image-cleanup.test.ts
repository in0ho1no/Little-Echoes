import { describe, expect, it } from 'vitest';

import { dispatchImageCleanup, runImageCleanup } from '../src/image-cleanup';
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
});
