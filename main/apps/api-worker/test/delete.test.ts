import { describe, expect, it } from 'vitest';

import {
  ensureDeleteWorkflow,
  RETENTION_BATCH_SIZE,
  RETENTION_RECONCILE_BATCH_SIZE,
  runDeleteWorkflow,
  scheduleRetentionCleanup,
} from '../src/delete';
import type { Env } from '../src/types';

interface BoundStatement {
  sql: string;
  values: unknown[];
}

function deleteEnv(
  options: { alwaysFailR2Delete?: boolean; failFirstR2Delete?: boolean; tombstoneAfterCommitError?: boolean; reconcilingCount?: number } = {},
): {
  env: Env;
  statements: BoundStatement[];
  r2Deletes: string[][];
} {
  const statements: BoundStatement[] = [];
  const r2Deletes: string[][] = [];
  let r2Calls = 0;
  let finalDeleteBatch = false;
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        return {
          first: async () => {
            if (sql.includes('FROM async_jobs j JOIN recordings')) {
              return { id: 'job_delete', household_id: 'household_1', recording_id: 'rec_1', correlation_id: 'cor_1', status: 'dispatched', audio_object_key: 'recordings/rec_1/audio.wav' };
            }
            if (sql.includes('FROM async_jobs WHERE recording_id')) return null;
            if (sql.includes('FROM recording_tombstones')) return finalDeleteBatch && options.tombstoneAfterCommitError ? { recording_id: 'rec_1' } : null;
            if (sql.includes('COUNT(*) AS count')) return { count: 0 };
            return null;
          },
          all: async () => {
            const results = sql.includes('SELECT DISTINCT dictionary_word_id')
              ? [{ dictionary_word_id: 'word_1' }]
              : sql.includes('SELECT image_object_key')
                ? [{ image_object_key: 'recordings/rec_1/image.webp' }]
                : sql.includes("r.review_status = 'deleting'")
                  ? Array.from({ length: options.reconcilingCount ?? 0 }, (_, index) => ({
                      id: `rec_reconcile_${index}`,
                      household_id: 'household_1',
                      version: 2,
                      review_status: 'deleting',
                      async_job_id: `job_reconcile_${index}`,
                    }))
                  : [];
            return { results };
          },
          run: async () => ({ meta: { changes: 1 } }),
          sql,
          values,
        };
      },
    }),
    batch: async (batch: D1PreparedStatement[]) => {
      const sql = (batch as unknown as BoundStatement[]).map((statement) => statement.sql).join('\n');
      if (sql.includes("DELETE FROM recordings")) {
        finalDeleteBatch = true;
        if (options.tombstoneAfterCommitError) throw new Error('D1 result unknown');
      }
      return batch.map((_statement, index) => ({ meta: { changes: index === batch.length - 1 ? 1 : 1 } })) as D1Result<unknown>[];
    },
  } as unknown as D1Database;
  const env = {
    DB: database,
    PRIVATE_MEDIA: {
      delete: async (keys: string | string[]) => {
        r2Calls += 1;
        r2Deletes.push(Array.isArray(keys) ? keys : [keys]);
        if (options.alwaysFailR2Delete || (options.failFirstR2Delete && r2Calls === 1)) throw new Error('temporary R2 failure');
      },
    } as unknown as R2Bucket,
    ANALYSIS_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DELETE_WORKFLOW: {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>,
    DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64),
    DEMO_WRITE_ENABLED: 'false',
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    ADMIN_HOST: 'app.example.test',
    INGEST_HOST: 'ingest.example.test',
  } as Env;
  return { env, statements, r2Deletes };
}

function dispatchEnv(
  observedStatus: 'running' | 'unknown' = 'unknown',
  createdAt = new Date().toISOString(),
  terminateFails = false,
): {
  createdIds: string[];
  env: Env;
  state: { dispatchCount: number; errorCode: string | null; jobStatus: string; leaseUntil: string | null; recordingStatus: string; terminationCount: number };
} {
  const state = {
    dispatchCount: 0,
    errorCode: null as string | null,
    jobStatus: 'dispatch_pending',
    leaseUntil: null as string | null,
    recordingStatus: 'deleting',
    terminationCount: 0,
  };
  const createdIds: string[] = [];
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM async_jobs WHERE id = ?')) {
            return {
              id: 'job_same',
              status: state.jobStatus,
              dispatch_reconcile_count: state.dispatchCount,
              dispatch_lease_until: state.leaseUntil,
              last_error_code: state.errorCode,
              created_at: createdAt,
              started_at: null,
            };
          }
          if (sql.includes('FROM recording_tombstones')) return null;
          return null;
        },
        run: async () => {
          if (sql.includes('SET dispatch_reconcile_count = dispatch_reconcile_count + 1')) {
            if (!['dispatch_pending', 'dispatched', 'running'].includes(state.jobStatus) || state.dispatchCount >= 3 || state.leaseUntil) {
              return { meta: { changes: 0 } };
            }
            state.dispatchCount += 1;
            state.leaseUntil = String(values[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET dispatch_lease_until = ?') && sql.includes('dispatch_reconcile_count >= ?')) {
            if (!['dispatch_pending', 'dispatched', 'running'].includes(state.jobStatus) || state.leaseUntil) return { meta: { changes: 0 } };
            state.leaseUntil = String(values[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET status = CASE WHEN status = 'dispatch_pending'")) {
            state.jobStatus = 'dispatched';
            state.dispatchCount = 0;
            state.leaseUntil = null;
          }
          if (sql.includes('SET last_error_code = ?')) {
            state.errorCode = String(values[0]);
            if (sql.includes('dispatch_lease_until = NULL')) state.leaseUntil = null;
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
    batch: async () => {
      const changed = ['dispatch_pending', 'dispatched', 'running'].includes(state.jobStatus) ? 1 : 0;
      if (changed === 1) {
        state.jobStatus = 'failed';
        state.recordingStatus = 'delete_failed';
        state.leaseUntil = null;
      }
      return [{ meta: { changes: changed } }, { meta: { changes: changed } }] as D1Result<unknown>[];
    },
  } as unknown as D1Database;
  const env = {
    DB: database,
    PRIVATE_MEDIA: {} as R2Bucket,
    ANALYSIS_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DELETE_WORKFLOW: {
      create: async ({ id }: { id?: string }) => {
        createdIds.push(id ?? '');
        throw new Error('create result unknown');
      },
      get: async () => ({
        terminate: async () => {
          state.terminationCount += 1;
          if (terminateFails) throw new Error('termination result unknown');
        },
        status: async () => {
          if (observedStatus === 'unknown') throw new Error('status unknown');
          return { status: observedStatus };
        },
      }),
    } as unknown as Workflow<{ async_job_id: string }>,
    DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64),
    DEMO_WRITE_ENABLED: 'false',
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    ADMIN_HOST: 'app.example.test',
    INGEST_HOST: 'ingest.example.test',
  } as Env;
  return { createdIds, env, state };
}

describe('削除Workflow', () => {
  it('R2の一部失敗後も同じオブジェクトを有限再試行し、辞典再計算と全関連削除を行う', async () => {
    const { env, statements, r2Deletes } = deleteEnv({ failFirstR2Delete: true });
    let calls = 0;
    await runDeleteWorkflow(env, 'job_delete', async (_name, operation) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          calls += 1;
          await operation();
          return;
        } catch {
          // Workflowsの有限再試行をテストで模擬する。
        }
      }
    });
    expect(calls).toBe(2);
    expect(r2Deletes).toEqual([
      ['recordings/rec_1/audio.wav', 'recordings/rec_1/image.webp'],
      ['recordings/rec_1/audio.wav', 'recordings/rec_1/image.webp'],
    ]);
    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(sql).toContain("r.review_status = 'approved'");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM word_occurrences wo WHERE wo.dictionary_word_id = dictionary_words.id)');
    expect(sql).toContain('DELETE FROM word_occurrences');
    expect(sql).toContain('DELETE FROM diary_images');
    expect(sql).toContain('DELETE FROM transcripts');
    expect(sql).toContain('DELETE FROM processing_attempts');
    expect(sql).toContain('INSERT INTO recording_tombstones');
  });

  it('D1結果不明でもtombstoneを照合し、同じ削除を重複実行しない', async () => {
    const { env, r2Deletes } = deleteEnv({ tombstoneAfterCommitError: true });
    let calls = 0;
    await runDeleteWorkflow(env, 'job_delete', async (_name, operation) => {
      calls += 1;
      await operation();
    });
    expect(calls).toBe(1);
    expect(r2Deletes).toEqual([['recordings/rec_1/audio.wav', 'recordings/rec_1/image.webp']]);
  });

  it('削除本体の3回目の失敗で停止し、4回目を呼ばない', async () => {
    const { env, r2Deletes, statements } = deleteEnv({ alwaysFailR2Delete: true });
    await runDeleteWorkflow(env, 'job_delete', async (_name, operation) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await operation();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    });
    expect(r2Deletes).toHaveLength(3);
    expect(statements.some((statement) => statement.sql.includes("last_error_code = 'DELETE_FAILED'"))).toBe(true);
  });

  it('createとgetが不明な場合は同じWorkflow IDだけを3回起動照合し、その後は隔離する', async () => {
    const { createdIds, env, state } = dispatchEnv();
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    state.leaseUntil = null;
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    state.leaseUntil = null;
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    state.leaseUntil = null;
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    expect(createdIds).toEqual(['job_same', 'job_same', 'job_same']);
    expect(state).toMatchObject({ dispatchCount: 3, errorCode: 'DELETE_WORKFLOW_DISPATCH_QUARANTINED', jobStatus: 'dispatch_pending', recordingStatus: 'deleting' });
  });

  it('同時再調停はleaseによりWorkflow createを1回だけ実行する', async () => {
    const { createdIds, env, state } = dispatchEnv();
    const statuses = await Promise.all([ensureDeleteWorkflow(env, 'job_same'), ensureDeleteWorkflow(env, 'job_same')]);
    expect(createdIds).toEqual(['job_same']);
    expect(statuses.sort()).toEqual(['dispatch_pending', 'unknown']);
    expect(state.dispatchCount).toBe(1);
  });

  it('getでrunningを確認したらD1をdispatchedへ収束させる', async () => {
    const { env, state } = dispatchEnv('running');
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('dispatched');
    expect(state).toMatchObject({ dispatchCount: 0, jobStatus: 'dispatched', leaseUntil: null });
  });

  it('24時間以上停止したWorkflowを失敗へ収束させ、有限予算で再試行可能にする', async () => {
    const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString();
    const { env, state } = dispatchEnv('running', staleAt);
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('failed');
    expect(state).toMatchObject({ dispatchCount: 1, jobStatus: 'failed', recordingStatus: 'delete_failed', leaseUntil: null, terminationCount: 1 });
  });

  it('停止Workflowの終了を確認できない場合は新ジョブを許可しない', async () => {
    const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString();
    const { env, state } = dispatchEnv('running', staleAt, true);
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    expect(state.leaseUntil).not.toBeNull();
    state.leaseUntil = null;
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    state.leaseUntil = null;
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    state.leaseUntil = null;
    expect(await ensureDeleteWorkflow(env, 'job_same')).toBe('unknown');
    expect(state).toMatchObject({
      dispatchCount: 3,
      errorCode: 'DELETE_WORKFLOW_DISPATCH_QUARANTINED',
      jobStatus: 'dispatch_pending',
      recordingStatus: 'deleting',
      terminationCount: 3,
    });
  });

  it('停止Workflowの終了結果不明時もleaseにより終了要求を1回だけ送る', async () => {
    const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString();
    const { env, state } = dispatchEnv('running', staleAt, true);
    const statuses = await Promise.all([ensureDeleteWorkflow(env, 'job_same'), ensureDeleteWorkflow(env, 'job_same')]);
    expect(statuses.sort()).toEqual(['dispatch_pending', 'unknown']);
    expect(state.terminationCount).toBe(1);
    expect(state.leaseUntil).not.toBeNull();
  });

  it('スケジュールは期限クエリを固定小件数に制限する', async () => {
    const { env, statements } = deleteEnv();
    await scheduleRetentionCleanup(env);
    const dueQuery = statements.find((statement) => statement.sql.includes('retention_delete_after'));
    const reconcileQuery = statements.find((statement) => statement.sql.includes("r.review_status = 'deleting'"));
    expect(reconcileQuery?.values.at(-1)).toBe(RETENTION_RECONCILE_BATCH_SIZE);
    expect(reconcileQuery?.values.at(-2)).toBe(3);
    expect(reconcileQuery?.sql).toContain('DELETE_WORKFLOW_DISPATCH_QUARANTINED');
    expect(dueQuery?.values.at(-1)).toBe(RETENTION_BATCH_SIZE);
    expect(dueQuery?.values.at(-2)).toBe(3);
    expect(dueQuery?.sql).toContain("review_status IN ('pending', 'approved', 'delete_failed')");
    expect(dueQuery?.sql).toContain("j.status = 'failed'");
  });

  it('再調停5件を同じcronの期限候補から除外し、別録音へ5枠を残す', async () => {
    const { env, statements } = deleteEnv({ reconcilingCount: RETENTION_RECONCILE_BATCH_SIZE });
    await scheduleRetentionCleanup(env);
    const dueQuery = statements.find((statement) => statement.sql.includes('retention_delete_after'));
    expect(dueQuery?.values.at(-1)).toBe(RETENTION_BATCH_SIZE - RETENTION_RECONCILE_BATCH_SIZE);
    expect(dueQuery?.sql).toContain('AND id NOT IN (?,?,?,?,?)');
    expect(dueQuery?.values.slice(2, -1)).toEqual(Array.from({ length: 5 }, (_, index) => `rec_reconcile_${index}`));
  });
});
