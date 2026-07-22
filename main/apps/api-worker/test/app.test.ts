import { beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/app';
import { hmacToken } from '../src/auth';
import type { Env } from '../src/types';
import { validateCanonicalWav } from '../src/wav';
import { wav } from './wav.test';

const TOKEN = 'a'.repeat(43);
const SECRET = 'x'.repeat(64);
const CAPTURE_ID = '11111111-1111-4111-8111-111111111111';
const RECORDING_ID = 'rec_11111111111111111111111111111111';
let tokenHmac = '';

type FirstHandler = (sql: string) => unknown;
type RunHandler = (sql: string) => D1Result<unknown>;

type AllHandler = (sql: string) => unknown[];

function fakeDatabase(
  first: FirstHandler,
  run: RunHandler = () => ({ meta: { changes: 1 } }) as D1Result<unknown>,
  allRows: AllHandler = () => [],
): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._values: unknown[]) => ({
        first: async () => first(sql),
        run: async () => run(sql),
        all: async () => ({ results: allRows(sql) }),
      }),
    }),
    batch: async (statements: unknown[]) => statements.map(() => ({ meta: { changes: 1 } })),
  } as unknown as D1Database;
}

function env(first: FirstHandler, run?: RunHandler, allRows?: AllHandler): Env {
  return {
    DB: fakeDatabase(first, run, allRows),
    PRIVATE_MEDIA: { put: async () => null } as unknown as R2Bucket,
    ANALYSIS_WORKFLOW: {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>,
    DELETE_WORKFLOW: {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>,
    DEVICE_TOKEN_HMAC_SECRET: SECRET,
    DEMO_WRITE_ENABLED: 'true',
    ACCESS_TEAM_DOMAIN: 'plain-queen-6b95.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    ADMIN_HOST: 'app.example.test',
    INGEST_HOST: 'ingest.example.test',
  };
}

function deviceRow(): Record<string, string> {
  return { id: 'dev_1', household_id: 'household_1', source_id: 'source_1', source_type: 'pc', token_hmac: tokenHmac };
}

function recordingRow(analysisStatus = 'failed'): Record<string, string | number | null> {
  return {
    id: RECORDING_ID,
    household_id: 'household_1',
    source_id: 'source_1',
    source_type: 'pc',
    audio_sha256: '0'.repeat(64),
    audio_object_key: `recordings/${RECORDING_ID}/audio.wav`,
    analysis_status: analysisStatus,
    review_status: 'pending',
    version: 1,
    captured_at: '2026-07-21T00:00:00.000Z',
    captured_timezone: 'Asia/Tokyo',
    captured_at_source: 'client_clock',
    received_at: '2026-07-21T00:00:00.000Z',
    upload_status: 'ready',
    duration_seconds: 15,
    pre_roll_seconds: 10,
    post_roll_seconds: 5,
    draft_scene: null,
    draft_parent_note: null,
  };
}

async function requestWithForm(audio: Uint8Array, suppliedEnv: Env): Promise<Response> {
  const form = new FormData();
  form.set('audio', new File([audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer], 'capture.wav', { type: 'audio/wav' }));
  form.set('client_capture_id', CAPTURE_ID);
  form.set('captured_at', '2026-07-21T00:00:00.000Z');
  form.set('captured_timezone', 'Asia/Tokyo');
  form.set('pre_roll_seconds', '10');
  form.set('post_roll_seconds', '5');
  form.set('post_roll_truncated', 'false');
  return app.fetch(
    new Request('https://ingest.example.test/api/v1/recordings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Length': '1000000' },
      body: form,
    }),
    suppliedEnv,
  );
}

async function requestWithoutLength(suppliedEnv: Env): Promise<Response> {
  const form = new FormData();
  const audio = wav();
  form.set('audio', new File([audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer], 'capture.wav', { type: 'audio/wav' }));
  form.set('client_capture_id', CAPTURE_ID);
  form.set('captured_at', '2026-07-21T00:00:00.000Z');
  form.set('captured_timezone', 'Asia/Tokyo');
  form.set('pre_roll_seconds', '10');
  form.set('post_roll_seconds', '5');
  form.set('post_roll_truncated', 'false');
  return app.fetch(new Request('https://ingest.example.test/api/v1/recordings', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form }), suppliedEnv);
}

describe('ルーターと録音API', () => {
  beforeAll(async () => {
    tokenHmac = await hmacToken(TOKEN, SECRET);
  });

  it('未知ホストを認証前にdeny-by-defaultで拒否する', async () => {
    const response = await app.fetch(new Request('https://unexpected.example.test/api/v1/review-queue'), env(() => null));
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('HTTPを認証とD1参照より前に拒否する', async () => {
    const response = await app.fetch(new Request('http://ingest.example.test/api/v1/recordings', { method: 'POST' }), env(() => {
      throw new Error('D1へ到達してはならない');
    }));
    expect(response.status).toBe(404);
  });

  it('管理ホストはデバイストークンを管理認証として受け付けない', async () => {
    const response = await app.fetch(
      new Request('https://app.example.test/', { headers: { Authorization: `Bearer ${TOKEN}` } }),
      env(() => deviceRow()),
    );
    expect(response.status).toBe(401);
  });

  it('DEMO_WRITE_ENABLED=falseは録音作成と解析要求を認証後に拒否する', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      throw new Error('書き込み無効時はD1の録音参照へ到達してはならない');
    });
    supplied.DEMO_WRITE_ENABLED = 'false';
    const create = await requestWithForm(wav(), supplied);
    expect(create.status).toBe(403);
    await expect(create.json()).resolves.toMatchObject({ code: 'DEMO_WRITE_DISABLED', retryable: false });
    const process = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}/process`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(process.status).toBe(403);
    await expect(process.json()).resolves.toMatchObject({ code: 'DEMO_WRITE_DISABLED' });
  });

  it('review.jsの生Responseにも相関IDとnosniffヘッダーを付ける', async () => {
    const supplied = env((sql) => (sql.includes('FROM management_principals') ? { household_id: 'household_1' } : null));
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/assets/review.js', { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Correlation-Id')).toMatch(/^corr_/);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('不正WAVをR2保存前に拒否する', async () => {
    const response = await requestWithForm(new Uint8Array([1, 2, 3]), env((sql) => (sql.includes('FROM device_tokens') ? deviceRow() : null)));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_WAV', retryable: false });
  });

  it('Content-Lengthがないmultipartを展開前に拒否する', async () => {
    const response = await requestWithoutLength(env((sql) => (sql.includes('FROM device_tokens') ? deviceRow() : null)));
    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONTENT_LENGTH_REQUIRED' });
  });

  it('同じclient_capture_idと同じWAVを重複作成しない', async () => {
    const valid = wav();
    const hash = (await validateCanonicalWav(valid)).sha256;
    const response = await requestWithForm(
      valid,
      env((sql) => {
        if (sql.includes('FROM device_tokens')) return deviceRow();
        if (sql.includes('client_capture_id')) {
          return {
            id: RECORDING_ID,
            household_id: 'household_1',
            source_id: 'source_1',
            audio_sha256: hash,
            analysis_status: 'pending',
            review_status: 'pending',
            version: 1,
            captured_at: '2026-07-21T00:00:00.000Z',
            captured_timezone: 'Asia/Tokyo',
            captured_at_source: 'client_clock',
            received_at: '2026-07-21T00:00:00.000Z',
            upload_status: 'ready',
          };
        }
        return null;
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ recording_id: RECORDING_ID, deduplicated: true, correlation_id: expect.stringMatching(/^corr_/) });
  });

  it('同じ録音がR2保存中の場合は成功を返さない', async () => {
    const valid = wav();
    const hash = (await validateCanonicalWav(valid)).sha256;
    const response = await requestWithForm(
      valid,
      env(
        (sql) => {
          if (sql.includes('FROM device_tokens')) return deviceRow();
          if (sql.includes('client_capture_id')) {
            return {
              id: RECORDING_ID,
              household_id: 'household_1',
              source_id: 'source_1',
              audio_sha256: hash,
              audio_object_key: `recordings/${RECORDING_ID}.wav`,
              analysis_status: 'pending',
              review_status: 'pending',
              version: 1,
              captured_at: '2026-07-21T00:00:00.000Z',
              captured_timezone: 'Asia/Tokyo',
              captured_at_source: 'client_clock',
              received_at: '2026-07-21T00:00:00.000Z',
              upload_status: 'reserved',
            };
          }
          return null;
        },
        (sql) => {
          if (sql.includes('updated_at <=')) return { meta: { changes: 0 } } as D1Result<unknown>;
          return { meta: { changes: 1 } } as D1Result<unknown>;
        },
      ),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'UPLOAD_IN_PROGRESS' });
  });

  it('録音INSERTのmeta.changesがトリガー書き込みを含んでも新規作成を成功させる', async () => {
    const supplied = env(
      (sql) => {
        if (sql.includes('FROM device_tokens')) return deviceRow();
        if (sql.includes('client_capture_id')) return null;
        if (sql.includes('FROM recordings r JOIN sources')) return { ...recordingRow('pending'), upload_status: 'ready' };
        return null;
      },
      (sql) => {
        if (sql.startsWith('INSERT INTO recordings')) return { meta: { changes: 2 } } as D1Result<unknown>;
        return { meta: { changes: 1 } } as D1Result<unknown>;
      },
    );
    const response = await requestWithForm(wav(), supplied);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ recording_id: RECORDING_ID, deduplicated: false });
  });

  it('期限を超えたreserved予約をfailedへ収束させ、同じ録音を再保存する', async () => {
    const valid = wav();
    const hash = (await validateCanonicalWav(valid)).sha256;
    const convergeSql: string[] = [];
    const supplied = env(
      (sql) => {
        if (sql.includes('FROM device_tokens')) return deviceRow();
        if (sql.includes('client_capture_id')) {
          return { ...recordingRow('pending'), audio_sha256: hash, upload_status: 'reserved' };
        }
        if (sql.includes('FROM recordings r JOIN sources')) {
          return { ...recordingRow('pending'), audio_sha256: hash, upload_status: 'ready' };
        }
        return null;
      },
      (sql) => {
        if (sql.includes('updated_at <=')) convergeSql.push(sql);
        return { meta: { changes: 1 } } as D1Result<unknown>;
      },
    );
    const response = await requestWithForm(valid, supplied);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ recording_id: RECORDING_ID, deduplicated: true });
    expect(convergeSql).toHaveLength(1);
    expect(convergeSql[0]).toContain("upload_status = ?");
  });

  it('日次録音上限に達した場合は作成を拒否する', async () => {
    const response = await requestWithForm(
      wav(),
      env(
        (sql) => {
          if (sql.includes('FROM device_tokens')) return deviceRow();
          if (sql.includes('FROM usage_counters')) return { used_count: 30 };
          return null;
        },
        (sql) => {
          if (sql.startsWith('INSERT INTO recordings')) throw new Error('recording_daily_limit_reached');
          return { meta: { changes: 1 } } as D1Result<unknown>;
        },
      ),
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: 'COST_LIMIT_REACHED' });
  });

  it('予期しない例外を固定の安全なエラーへ変換する', async () => {
    const response = await app.fetch(
      new Request('https://ingest.example.test/api/v1/recordings', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
      env(() => {
        throw new Error('secret database detail');
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toContain('secret database detail');
  });

  it('別デバイスの録音状態を返さない', async () => {
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      env((sql) => (sql.includes('FROM device_tokens') ? deviceRow() : null)),
    );
    expect(response.status).toBe(404);
  });

  it('累積3試行後はAsyncJobもWorkflowも作成しない', async () => {
    let jobInserted = false;
    const supplied = env(
      (sql) => {
        if (sql.includes('FROM device_tokens')) return deviceRow();
        if (sql.includes('FROM recordings r JOIN sources')) return recordingRow();
        if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 3 };
        return null;
      },
      (sql) => {
        if (sql.startsWith('INSERT INTO async_jobs')) jobInserted = true;
        return { meta: { changes: 1 } } as D1Result<unknown>;
      },
    );
    let workflowCreated = false;
    supplied.ANALYSIS_WORKFLOW = { create: async () => { workflowCreated = true; } } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}/process`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'PROCESSING_ATTEMPT_LIMIT_REACHED', retryable: false });
    expect(jobInserted).toBe(false);
    expect(workflowCreated).toBe(false);
  });

  it('解析受付成功をOpenAPIのAcceptedJob形式で返す', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('pending');
      if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 0 };
      return null;
    });
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}/process`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(202);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      async_job_id: expect.stringMatching(/^job_/),
      status: 'dispatched',
      correlation_id: expect.stringMatching(/^corr_/),
    });
  });

  it('Workflow受付結果不明時は同じAsyncJob IDだけを再確認する', async () => {
    const job = { id: 'job_11111111111111111111111111111111', status: 'dispatch_pending', correlation_id: 'corr_original', last_error_code: null };
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('pending');
      if (sql.includes('FROM async_jobs') && sql.includes("status IN ('dispatch_pending'")) return job;
      return null;
    });
    const createdIds: string[] = [];
    supplied.ANALYSIS_WORKFLOW = {
      create: async (options: { id?: string }) => {
        createdIds.push(options.id ?? '');
        throw new Error('result unknown');
      },
      get: async () => {
        throw new Error('status unknown');
      },
    } as unknown as Workflow<{ async_job_id: string }>;
    for (let count = 0; count < 2; count += 1) {
      const response = await app.fetch(
        new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}/process`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
        supplied,
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ code: 'UPSTREAM_RESULT_UNKNOWN', retryable: false });
    }
    expect(new Set(createdIds)).toEqual(new Set([job.id]));
  });

  it('確認待ち一覧の空状態をOpenAPI形式で返す', async () => {
    const supplied = env((sql) => (sql.includes('FROM management_principals') ? { household_id: 'household_1' } : null));
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/api/v1/review-queue', { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], failed_deletions: [], correlation_id: expect.stringMatching(/^corr_/) });
  });

  it('削除失敗の録音を再試行に必要なversionつきで一覧へ返す', async () => {
    const supplied = env(
      (sql) => (sql.includes('FROM management_principals') ? { household_id: 'household_1' } : null),
      undefined,
      (sql) =>
        sql.includes("review_status = 'delete_failed'")
          ? [{ id: RECORDING_ID, captured_at: '2026-07-21T00:00:00.000Z', captured_timezone: 'Asia/Tokyo', version: 3 }]
          : [],
    );
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/api/v1/review-queue', { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed_deletions: [{ recording_id: RECORDING_ID, captured_at: '2026-07-21T00:00:00.000Z', version: 3 }],
    });
  });

  it('15分更新のない解析ジョブをGETで照合し、終了済みならfailedへ収束する', async () => {
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('transcribing');
      if (sql.includes('ORDER BY operation_number DESC')) {
        return { id: 'job_stale', status: 'running', correlation_id: 'cor_stale', last_error_code: null, updated_at: staleUpdatedAt };
      }
      return null;
    });
    supplied.ANALYSIS_WORKFLOW = {
      get: async () => ({ status: async () => ({ status: 'errored' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body.async_job).toBeUndefined();
    expect(body.error).toMatchObject({ code: 'UPSTREAM_RESULT_UNKNOWN', retryable: false });
  });

  it('15分停止したdispatch_pendingジョブは同一IDでWorkflow作成を再確認する', async () => {
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const createdIds: string[] = [];
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('pending');
      if (sql.includes('ORDER BY operation_number DESC')) {
        return { id: 'job_pending', status: 'dispatch_pending', correlation_id: 'corr_pending', last_error_code: null, updated_at: staleUpdatedAt };
      }
      return null;
    });
    supplied.ANALYSIS_WORKFLOW = {
      create: async (options: { id?: string }) => {
        createdIds.push(options.id ?? '');
      },
    } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(createdIds).toEqual(['job_pending']);
    expect(body.async_job).toMatchObject({ async_job_id: 'job_pending', status: 'dispatched' });
  });

  it('review.jsスクリプトが削除再試行に必要な要素を含む', async () => {
    const supplied = env((sql) => (sql.includes('FROM management_principals') ? { household_id: 'household_1' } : null));
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/assets/review.js', { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    const script = await response.text();
    expect(script).toContain('failed_deletions');
    expect(script).toContain("method:'DELETE'");
    expect(script).toContain('JSON.stringify({version:target.version})');
    expect(script).toContain('/^rec_[a-z0-9]{32}$/');
    expect(script).toContain('button.disabled=false');
  });

  it('実行中と確認できた解析ジョブは収束させず処理中を返す', async () => {
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('transcribing');
      if (sql.includes('ORDER BY operation_number DESC')) {
        return { id: 'job_stale', status: 'running', correlation_id: 'cor_stale', last_error_code: null, updated_at: staleUpdatedAt };
      }
      return null;
    });
    supplied.ANALYSIS_WORKFLOW = {
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body.error).toBeUndefined();
    expect(body.async_job).toMatchObject({ async_job_id: 'job_stale', status: 'running' });
  });

  it('管理削除は楽観ロックのversion不一致を拒否する', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) return { ...recordingRow(), version: 2 };
      return null;
    });
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}`, {
        method: 'DELETE',
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token', 'Content-Type': 'application/json', 'Content-Length': '13' },
        body: '{"version":1}',
      }),
      supplied,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('削除中の録音は管理詳細と音声APIから非表示にする', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) return { ...recordingRow(), review_status: 'deleting' };
      return null;
    });
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const headers = { 'Cf-Access-Jwt-Assertion': 'signed-test-token' };
    const detail = await app.fetch(new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}`, { headers }), supplied);
    const audio = await app.fetch(new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/audio`, { headers }), supplied);
    expect(detail.status).toBe(404);
    expect(audio.status).toBe(404);
  });

  it('他世帯の管理削除は録音の存在を返さない', async () => {
    const supplied = env((sql) => (sql.includes('FROM management_principals') ? { household_id: 'household_1' } : null));
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}`, {
        method: 'DELETE',
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token', 'Content-Type': 'application/json', 'Content-Length': '13' },
        body: '{"version":1}',
      }),
      supplied,
    );
    expect(response.status).toBe(404);
  });
});
