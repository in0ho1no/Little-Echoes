import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { runMockAnalysis } from '../src/workflow';

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

describe('モック解析Workflow', () => {
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
