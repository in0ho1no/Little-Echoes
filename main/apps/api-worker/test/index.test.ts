import { describe, expect, it } from 'vitest';

import worker, { DAILY_FULL_CRON } from '../src/index';
import type { Env } from '../src/types';

interface ScheduledFixture {
  env: Env;
  sqlLog: string[];
  readonly listCalls: number;
}

function scheduledEnv(options: { failReconcile?: boolean } = {}): ScheduledFixture {
  const sqlLog: string[] = [];
  const tracker = { listCalls: 0 };
  const statement = (sql: string): Record<string, unknown> => ({
    sql,
    bind: (..._values: unknown[]) => statement(sql),
    first: async () => { sqlLog.push(sql); return null; },
    run: async () => { sqlLog.push(sql); return { meta: { changes: 1 } }; },
    all: async () => {
      sqlLog.push(sql);
      if (options.failReconcile && sql.includes("job_type IN ('diary','image')")) throw new Error('D1 unavailable');
      return { results: [] };
    },
  });
  const env = {
    DB: { prepare: statement, batch: async (items: unknown[]) => items.map(() => ({ meta: { changes: 1 } })) } as unknown as D1Database,
    PRIVATE_MEDIA: {
      list: async () => { tracker.listCalls += 1; return { truncated: false, objects: [] }; },
      delete: async () => undefined,
    } as unknown as R2Bucket,
    ANALYSIS_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DELETE_WORKFLOW: { create: async () => ({}), get: async () => ({ status: async () => ({ status: 'running' }) }) } as unknown as Workflow<{ async_job_id: string }>,
    DIARY_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    IMAGE_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    IMAGE_CLEANUP_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64), DEMO_WRITE_ENABLED: 'true', ACCESS_TEAM_DOMAIN: 'team', ACCESS_AUD: 'aud', ADMIN_HOST: 'app', INGEST_HOST: 'ingest',
  } as Env;
  return { env, sqlLog, get listCalls() { return tracker.listCalls; } };
}

function runScheduled(cron: string, env: Env): Promise<unknown> {
  let settled: Promise<unknown> = Promise.resolve();
  const ctx = { waitUntil: (promise: Promise<unknown>) => { settled = promise; } } as unknown as ExecutionContext;
  worker.scheduled({ cron } as unknown as ScheduledEvent, env, ctx);
  return settled;
}

describe('scheduled cron分岐', () => {
  it('runs retention and sweep only on the daily cron', async () => {
    const hourly = scheduledEnv();
    await runScheduled('47 * * * *', hourly.env);
    expect(hourly.listCalls).toBe(0);
    expect(hourly.sqlLog.some((sql) => sql.includes("job_type = 'delete'"))).toBe(false);

    const daily = scheduledEnv();
    await runScheduled(DAILY_FULL_CRON, daily.env);
    expect(daily.listCalls).toBe(1);
    expect(daily.sqlLog.some((sql) => sql.includes("job_type = 'delete'"))).toBe(true);
  });

  it('fails the scheduled invocation when a scheduled task rejects', async () => {
    const { env } = scheduledEnv({ failReconcile: true });
    await expect(runScheduled('47 * * * *', env)).rejects.toThrow('scheduled task');
  });
});
