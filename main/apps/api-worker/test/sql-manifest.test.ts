import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ensureDeleteWorkflow, reserveDeleteJob, runDeleteWorkflow, scheduleRetentionCleanup } from '../src/delete';
import { approveReview, saveReview } from '../src/review';
import type { Env } from '../src/types';
import { reconcileStaleAnalysisJob, runMockAnalysis } from '../src/workflow';

// 本番コードが準備する全SQL文を捕捉し、pytest側が実SQLiteでEXPLAINコンパイル
// 検証できるマニフェストへ書き出す。文字列モックでは検出できない曖昧列名や
// 構文非互換（Phase 3の本番障害）をデプロイ前に検出するための基盤。
function capturingEnv(collected: Set<string>): Env {
  const statement = (sql: string): Record<string, unknown> => ({
    sql,
    bind: (..._values: unknown[]) => statement(sql),
    first: async () => {
      collected.add(sql);
      if (sql.includes('FROM async_jobs j JOIN recordings')) {
        return { id: 'job_1', household_id: 'hh', recording_id: 'rec_1', correlation_id: 'corr_1', status: 'dispatched', audio_object_key: 'k' };
      }
      if (sql.includes('FROM async_jobs WHERE id')) {
        return {
          id: 'job_1',
          recording_id: 'rec_1',
          household_id: 'hh',
          correlation_id: 'corr_1',
          operation_number: 1,
          status: 'dispatched',
          dispatch_reconcile_count: 0,
          dispatch_lease_until: null,
          last_error_code: null,
          created_at: '2026-07-22T00:00:00.000Z',
          started_at: null,
        };
      }
      return null;
    },
    run: async () => {
      collected.add(sql);
      return { meta: { changes: 1 } };
    },
    all: async () => {
      collected.add(sql);
      return { results: [] };
    },
  });
  return {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: { sql: string }[]) => {
        statements.forEach((bound) => collected.add(bound.sql));
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database,
    PRIVATE_MEDIA: { delete: async () => undefined } as unknown as R2Bucket,
    ANALYSIS_WORKFLOW: { create: async () => ({}), get: async () => ({ status: async () => ({ status: 'errored' }) }) } as unknown as Workflow<{ async_job_id: string }>,
    DELETE_WORKFLOW: { create: async () => ({}), get: async () => ({ status: async () => ({ status: 'running' }) }) } as unknown as Workflow<{ async_job_id: string }>,
    DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64),
    DEMO_WRITE_ENABLED: 'true',
    ACCESS_TEAM_DOMAIN: 'team.example.test',
    ACCESS_AUD: 'aud',
    ADMIN_HOST: 'app.example.test',
    INGEST_HOST: 'ingest.example.test',
  } as Env;
}

describe('SQLマニフェスト', () => {
  it('review/delete/workflowの捕捉SQLがコミット済みマニフェストと一致する', async () => {
    const collected = new Set<string>();
    const env = capturingEnv(collected);
    const target = { id: 'rec_1', householdId: 'hh', version: 1, reviewStatus: 'pending', analysisStatus: 'ready', capturedAt: '2026-07-22T00:00:00.000Z' };
    const input = {
      version: 1,
      reviewedText: 'テスト',
      words: [{ displayName: 'りんご', normalized: 'りんご', newOverride: 'auto' as const }],
      capturedAt: '2026-07-21T00:00:00.000Z',
      capturedTimezone: 'Asia/Tokyo',
      scene: null,
      parentNote: null,
    };
    await saveReview(env.DB, target, input, 'subject', 'corr_1');
    await approveReview(env.DB, { ...target, reviewStatus: 'approved' }, input, 'subject', 'corr_1');
    await runMockAnalysis(env, 'job_1', async (_name, _limit, operation) => operation());
    await reconcileStaleAnalysisJob(env, {
      id: 'job_1',
      status: 'running',
      updated_at: '2020-01-01T00:00:00.000Z',
      recording_id: 'rec_1',
      household_id: 'hh',
    });
    await runDeleteWorkflow(env, 'job_1', async (_name, operation) => operation());
    await reserveDeleteJob(env, { id: 'rec_1', household_id: 'hh', version: 1, review_status: 'pending' }, 1, 'system', 'scheduler', 'corr_1');
    await ensureDeleteWorkflow(env, 'job_1');
    await scheduleRetentionCleanup(env);

    const statements = [...collected].sort();
    expect(statements.length).toBeGreaterThan(25);
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql-manifest.json');
    const committed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { statements: string[] };
    expect(committed.statements).toEqual(statements);
  });
});
