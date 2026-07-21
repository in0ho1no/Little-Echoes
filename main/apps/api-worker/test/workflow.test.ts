import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { reconcileStaleAnalysisJob, runMockAnalysis } from '../src/workflow';

interface BoundStatement {
  sql: string;
  values: unknown[];
}

function workflowDatabase(batches: BoundStatement[][]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM async_jobs WHERE id')) {
            return {
              id: 'job_1',
              recording_id: 'rec_1',
              household_id: 'household_1',
              correlation_id: 'corr_1',
              operation_number: 1,
              status: 'dispatched',
            };
          }
          return null;
        },
        run: async () => ({ meta: { changes: 1 } }),
        sql,
        values,
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) => {
      const bound = statements as unknown as BoundStatement[];
      batches.push(bound);
      return bound.map(() => ({ meta: { changes: 1 } })) as D1Result<unknown>[];
    },
  } as unknown as D1Database;
}

function staleEnv(options: { observedStatus?: string; statusThrows?: boolean } = {}): {
  env: Env;
  batches: string[][];
  runs: string[];
  statusCalls: () => number;
} {
  const batches: string[][] = [];
  const runs: string[] = [];
  let statusCallCount = 0;
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          sql,
          first: async () => null,
          run: async () => {
            runs.push(sql);
            return { meta: { changes: 1 } };
          },
        }),
      }),
      batch: async (statements: { sql: string }[]) => {
        batches.push(statements.map((statement) => statement.sql));
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database,
    ANALYSIS_WORKFLOW: {
      get: async () => ({
        status: async () => {
          statusCallCount += 1;
          if (options.statusThrows) throw new Error('status unknown');
          return { status: options.observedStatus ?? 'running' };
        },
      }),
    } as unknown as Workflow<{ async_job_id: string }>,
    DEMO_WRITE_ENABLED: 'true',
  } as Env;
  return { env, batches, runs, statusCalls: () => statusCallCount };
}

const STALE_JOB = {
  id: 'job_stale',
  status: 'running',
  recording_id: 'rec_1',
  household_id: 'household_1',
};

describe('解析ジョブの収束', () => {
  it('想定時間内はWorkflowを照合しない', async () => {
    const { env, statusCalls, batches } = staleEnv({ observedStatus: 'errored' });
    const fresh = { ...STALE_JOB, updated_at: new Date(Date.now() - 60 * 1000).toISOString() };
    await expect(reconcileStaleAnalysisJob(env, fresh)).resolves.toBe('active');
    expect(statusCalls()).toBe(0);
    expect(batches).toHaveLength(0);
  });

  it('想定時間超過かつWorkflow終了済みならattempt・ジョブ・録音をfailedへ収束する', async () => {
    const { env, batches } = staleEnv({ observedStatus: 'errored' });
    const stale = { ...STALE_JOB, updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() };
    await expect(reconcileStaleAnalysisJob(env, stale)).resolves.toBe('converged');
    const sql = batches.flat().join('\n');
    expect(sql).toContain("UPDATE processing_attempts SET status = 'failed'");
    expect(sql).toContain("UPDATE async_jobs SET status = 'failed'");
    expect(sql).toContain("UPDATE recordings SET analysis_status = 'failed'");
  });

  it('実行中を確認したらupdated_atだけを更新して処理中を維持する', async () => {
    const { env, batches, runs } = staleEnv({ observedStatus: 'running' });
    const stale = { ...STALE_JOB, updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() };
    await expect(reconcileStaleAnalysisJob(env, stale)).resolves.toBe('active');
    expect(batches).toHaveLength(0);
    expect(runs.some((statement) => statement.includes('UPDATE async_jobs SET updated_at'))).toBe(true);
  });

  it('照合不明時は状態を変更しない', async () => {
    const { env, batches, runs } = staleEnv({ statusThrows: true });
    const stale = { ...STALE_JOB, updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() };
    await expect(reconcileStaleAnalysisJob(env, stale)).resolves.toBe('unknown');
    expect(batches).toHaveLength(0);
    expect(runs).toHaveLength(0);
  });
});

describe('モック解析Workflow', () => {
  it('ステップ再実行時は前回のrunning attemptを終端してから新attemptを予約する', async () => {
    const runs: string[] = [];
    const database = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (sql.includes('FROM async_jobs WHERE id')) {
              return {
                id: 'job_1',
                recording_id: 'rec_1',
                household_id: 'household_1',
                correlation_id: 'corr_1',
                operation_number: 1,
                status: 'dispatched',
              };
            }
            return null;
          },
          run: async () => {
            runs.push(sql);
            return { meta: { changes: 1 } };
          },
        }),
      }),
      batch: async (statements: unknown[]) => statements.map(() => ({ meta: { changes: 1 } })),
    } as unknown as D1Database;
    const env = { DB: database, DEMO_WRITE_ENABLED: 'true' } as Env;
    await runMockAnalysis(env, 'job_1', async (_name, _limit, operation) => {
      await operation();
    });
    const finalizeIndex = runs.findIndex((sql) => sql.includes("error_code = 'STEP_REEXECUTED'"));
    const reserveIndex = runs.findIndex((sql) => sql.includes('INSERT INTO processing_attempts'));
    expect(finalizeIndex).toBeGreaterThanOrEqual(0);
    expect(reserveIndex).toBeGreaterThan(finalizeIndex);
    expect(runs[finalizeIndex]).toContain("status IN ('dispatch_pending', 'dispatched', 'running')");
  });

  it('全ての内容更新をactive_attempt_idとpending条件でguardする', async () => {
    const batches: BoundStatement[][] = [];
    const env = {
      DB: workflowDatabase(batches),
      DEMO_WRITE_ENABLED: 'true',
    } as Env;
    let retryLimit = 0;
    await runMockAnalysis(env, 'job_1', async (_name, limit, operation) => {
      retryLimit = limit;
      await operation();
    });
    expect(retryLimit).toBe(2);
    const resultBatch = batches.find((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO transcripts')));
    expect(resultBatch).toBeDefined();
    const contentSql = resultBatch?.map((statement) => statement.sql).join('\n') ?? '';
    expect(contentSql).toContain("active_attempt_id = ? AND review_status = 'pending'");
    expect(contentSql).toContain("UPDATE processing_attempts SET status = 'succeeded'");
    expect(contentSql).toContain("UPDATE async_jobs SET status = 'succeeded'");
  });
});
