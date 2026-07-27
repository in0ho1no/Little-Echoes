import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ensureDeleteWorkflow, reserveDeleteJob, runDeleteWorkflow, scheduleRetentionCleanup } from '../src/delete';
import { OpenAiAnalysisError, type OpenAiAnalysisClient } from '../src/openai-analysis';
import { app } from '../src/app';
import { approveReview, saveReview } from '../src/review';
import type { Env } from '../src/types';
import { reconcileStaleAnalysisJob, runOpenAiAnalysis } from '../src/workflow';

// 本番コードが準備する全SQL文を捕捉し、pytest側が実SQLiteでEXPLAINコンパイル
// 検証できるマニフェストへ書き出す。文字列モックでは検出できない曖昧列名や
// 構文非互換（Phase 3の本番障害）をデプロイ前に検出するための基盤。
function canonicalWav(): Uint8Array {
  const bytes = new Uint8Array(48_044);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let index = 0; index < 4; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.byteLength - 44, true);
  return bytes;
}

function capturingEnv(collected: Set<string>): Env {
  const statement = (sql: string): Record<string, unknown> => ({
    sql,
    bind: (..._values: unknown[]) => statement(sql),
    first: async () => {
      collected.add(sql);
      if (sql.includes('FROM async_jobs j JOIN recordings')) {
        return {
          id: 'job_1', household_id: 'hh', recording_id: 'rec_1', correlation_id: 'corr_1', operation_number: 1,
          status: 'dispatched', audio_object_key: 'k', draft_parent_note: null,
        };
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
      if (sql.includes('FROM management_principals')) return { household_id: 'hh' };
      if (sql.includes('FROM recordings r JOIN sources')) {
        return {
          id: 'rec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', household_id: 'hh', source_id: 'source_1',
          audio_sha256: 'a'.repeat(64), audio_object_key: 'k', analysis_status: 'partial', review_status: 'pending',
          version: 1, captured_at: '2026-07-23T00:00:00.000Z', captured_timezone: 'UTC', captured_at_source: 'client_clock',
          received_at: '2026-07-23T00:00:00.000Z', upload_status: 'ready', duration_seconds: 1, pre_roll_seconds: 0,
          post_roll_seconds: 0, draft_scene: null, draft_parent_note: null, source_type: 'pc',
        };
      }
      if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 0 };
      if (sql.includes('SELECT id FROM device_tokens')) return { id: 'token_1' };
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
    PRIVATE_MEDIA: {
      delete: async () => undefined,
      get: async () => {
        const bytes = canonicalWav();
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
      },
    } as unknown as R2Bucket,
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
    env.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'subject' });
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
    const fixedClock = () => new Date('2026-07-23T00:00:00.000Z');
    const readyClient: OpenAiAnalysisClient = {
      transcribe: async () => ({ value: 'りんご', requestId: 'req_transcription' }),
      extractWords: async () => ({ value: [{ surface: 'りんご', normalized: 'りんご', part_of_speech: 'noun' }], requestId: 'req_words' }),
    };
    const partialClient: OpenAiAnalysisClient = {
      transcribe: async () => ({ value: 'りんご', requestId: 'req_partial' }),
      extractWords: async () => ({ value: [], requestId: 'req_empty_words' }),
    };
    const failedClient: OpenAiAnalysisClient = {
      transcribe: async () => { throw new OpenAiAnalysisError('UPSTREAM_REJECTED', false); },
      extractWords: async () => ({ value: [], requestId: null }),
    };
    const unknownClient: OpenAiAnalysisClient = {
      transcribe: async () => { throw new OpenAiAnalysisError('UPSTREAM_RESULT_UNKNOWN', false); },
      extractWords: async () => ({ value: [], requestId: null }),
    };
    const oneStep = async (_name: string, _limit: number, operation: () => Promise<void>) => operation();
    await runOpenAiAnalysis(env, 'job_1', oneStep, readyClient, fixedClock);
    await runOpenAiAnalysis(env, 'job_1', oneStep, partialClient, fixedClock);
    await runOpenAiAnalysis(env, 'job_1', oneStep, failedClient, fixedClock);
    await runOpenAiAnalysis(env, 'job_1', oneStep, unknownClient, fixedClock);
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
    await app.fetch(
      new Request('https://app.example.test/api/v1/recordings/rec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/retry-analysis', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': 'test', 'Content-Type': 'application/json', 'Content-Length': '13' },
        body: '{"version":1}',
      }),
      env,
    );
    env.ANALYSIS_WORKFLOW = {
      create: async () => { throw new Error('fixture dispatch failure'); },
      get: async () => ({ status: async () => ({ status: 'errored' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    await app.fetch(
      new Request('https://app.example.test/api/v1/recordings/rec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/retry-analysis', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': 'test', 'Content-Type': 'application/json', 'Content-Length': '13' },
        body: '{"version":1}',
      }),
      env,
    );
    await app.fetch(
      new Request('https://app.example.test/recordings/rec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        headers: { 'Cf-Access-Jwt-Assertion': 'test' },
      }),
      env,
    );

    const statements = [...collected].sort();
    expect(statements.length).toBeGreaterThan(35);
    expect(statements.some((sql) => sql.includes('INSERT INTO processing_attempts'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO openai_call_reservations'))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO transcripts") && sql.includes('gpt-4o-transcribe'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO word_candidates') && sql.includes('active_attempt_id'))).toBe(true);
    expect(statements.some((sql) => sql.includes("error_code = ?") && sql.includes("status = 'failed'"))).toBe(true);
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql-manifest.json');
    const committed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { statements: string[] };
    expect([...committed.statements].sort()).toEqual(statements);
  });
});
