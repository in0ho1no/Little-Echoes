import { beforeAll, describe, expect, it } from 'vitest';

import { app, ensureMissingInitialDiaryJobs } from '../src/app';
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
type RunHandler = (sql: string, values: unknown[]) => D1Result<unknown>;

type AllHandler = (sql: string) => unknown[];

function fakeDatabase(
  first: FirstHandler,
  run: RunHandler = () => ({ meta: { changes: 1 } }) as D1Result<unknown>,
  allRows: AllHandler = () => [],
): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._values: unknown[]) => ({
        sql,
        values: _values,
        first: async () => first(sql),
        run: async () => run(sql, _values),
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
    DIARY_WORKFLOW: {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>,
    IMAGE_WORKFLOW: {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>,
    IMAGE_CLEANUP_WORKFLOW: {
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

  it('DEMO停止中でも認証済み画像DELETEはcleanupを予約する', async () => {
    let cleanupCreates = 0;
    const diary = { id: 'diary_11111111111111111111111111111111', household_id: 'household_1', recording_id: RECORDING_ID, diary_text: '日記', scene: null, version: 1, recording_version: 1, diary_status: 'ready', image_status: 'ready', captured_at: '2026-07-21T00:00:00.000Z', last_generation_error: null, active_image_id: 'image_11111111111111111111111111111111', active_image_created_at: null };
    const supplied = env((sql) => {
      if (sql.includes('management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM diary_entries d JOIN recordings')) return diary;
      if (sql.includes('SELECT image_object_key FROM diary_images')) return { image_object_key: 'diary-images/image_1.png' };
      if (sql.includes('FROM image_cleanup_jobs WHERE id')) return {
        id: 'job_cleanup',
        image_object_key: 'diary-images/image_1.png',
        status: 'dispatch_pending',
        attempt_count: 0,
        dispatch_reconcile_count: 0,
        dispatch_lease_until: null,
      };
      return null;
    });
    supplied.DEMO_WRITE_ENABLED = 'false';
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    supplied.IMAGE_CLEANUP_WORKFLOW = { create: async () => { cleanupCreates += 1; }, get: async () => ({ status: async () => ({ status: 'running' }) }) } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(new Request(`https://app.example.test/api/v1/diary/${diary.id}/image`, { method: 'DELETE', headers: { 'Cf-Access-Jwt-Assertion': 'signed', 'Content-Type': 'application/json' }, body: '{"version":1}' }), supplied);
    expect(response.status).toBe(202);
    expect(cleanupCreates).toBe(1);
  });

  it('household外 diary/image APIは404を返す', async () => {
    const supplied = env((sql) => sql.includes('management_principals') ? { household_id: 'household_1' } : null);
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const id = 'diary_22222222222222222222222222222222';
    const get = await app.fetch(new Request(`https://app.example.test/api/v1/diary/${id}`, { headers: { 'Cf-Access-Jwt-Assertion': 'signed' } }), supplied);
    const del = await app.fetch(new Request(`https://app.example.test/api/v1/diary/${id}/image`, { method: 'DELETE', headers: { 'Cf-Access-Jwt-Assertion': 'signed', 'Content-Type': 'application/json' }, body: '{"version":1}' }), supplied);
    expect(get.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it('approved録音の再承認は日記Workflowを自動起動しない', async () => {
    let diaryCreates = 0;
    const approved = { ...recordingRow('ready'), review_status: 'approved' };
    const supplied = env((sql) => {
      if (sql.includes('management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) return approved;
      if (sql.includes('SELECT d.id FROM diary_entries')) return { id: 'diary_11111111111111111111111111111111' };
      if (sql.includes('FROM diary_entries d JOIN recordings')) return { id: 'diary_11111111111111111111111111111111', household_id: 'household_1', recording_id: RECORDING_ID, diary_text: null, scene: null, version: 1, recording_version: 1, diary_status: 'ready', image_status: 'not_requested', captured_at: '2026-07-21T00:00:00.000Z', last_generation_error: null, active_image_id: null, active_image_created_at: null };
      return null;
    });
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    supplied.DIARY_WORKFLOW = { create: async () => { diaryCreates += 1; } } as unknown as Workflow<{ async_job_id: string }>;
    const body = { version: 1, reviewed_text: 'りんご', words: [], captured_at: '2026-07-21T00:00:00.000Z', captured_timezone: 'Asia/Tokyo', scene: '', parent_note: '' };
    const response = await app.fetch(new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/approve`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': 'signed', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), supplied);
    expect(response.status).toBe(200);
    expect(diaryCreates).toBe(0);
  });

  it('承認後の初回日記予約が欠落しても再承認要求で冪等に補う', async () => {
    let diaryCreates = 0;
    let recordingReads = 0;
    const approved = { ...recordingRow('ready'), review_status: 'approved', diary_status: 'not_started', image_status: 'not_requested' };
    const diary = {
      id: 'diary_11111111111111111111111111111111',
      household_id: 'household_1',
      recording_id: RECORDING_ID,
      diary_text: null,
      scene: null,
      version: 1,
      recording_version: 2,
      diary_status: 'not_started',
      image_status: 'not_requested',
      captured_at: '2026-07-21T00:00:00.000Z',
      last_generation_error: null,
      active_image_id: null,
      active_image_created_at: null,
    };
    const supplied = env((sql) => {
      if (sql.includes('management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) {
        recordingReads += 1;
        return recordingReads === 1 ? approved : { ...approved, version: 2 };
      }
      if (sql.includes('SELECT d.id FROM diary_entries')) return { id: diary.id };
      if (sql.includes('FROM diary_entries d JOIN recordings')) return diary;
      return null;
    });
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    supplied.DIARY_WORKFLOW = {
      create: async () => { diaryCreates += 1; },
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    const body = { version: 1, reviewed_text: 'りんご', words: [], captured_at: '2026-07-21T00:00:00.000Z', captured_timezone: 'Asia/Tokyo', scene: '', parent_note: '' };
    const response = await app.fetch(new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/approve`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': 'signed', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), supplied);
    expect(response.status).toBe(200);
    expect(diaryCreates).toBe(1);
  });

  it('cronは承認コミット後に欠落した初回日記jobだけを補う', async () => {
    let diaryCreates = 0;
    const diary = {
      id: 'diary_11111111111111111111111111111111',
      household_id: 'household_1',
      recording_id: RECORDING_ID,
      diary_text: null,
      scene: null,
      version: 1,
      recording_version: 2,
      diary_status: 'not_started',
      image_status: 'not_requested',
      captured_at: '2026-07-21T00:00:00.000Z',
      last_generation_error: null,
      active_image_id: null,
      active_image_created_at: null,
    };
    const supplied = env(
      (sql) => sql.includes('FROM diary_entries d JOIN recordings') ? diary : null,
      undefined,
      (sql) => sql.includes("r.diary_status = 'not_started'") ? [{ id: diary.id, household_id: 'household_1' }] : [],
    );
    supplied.DIARY_WORKFLOW = {
      create: async () => { diaryCreates += 1; },
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    await ensureMissingInitialDiaryJobs(supplied);
    expect(diaryCreates).toBe(1);
  });

  it('image daily/lifetime preflightはjobを作らない', async () => {
    const diary = { id: 'diary_11111111111111111111111111111111', household_id: 'household_1', recording_id: RECORDING_ID, diary_text: '日記', scene: null, version: 1, recording_version: 1, diary_status: 'ready', image_status: 'not_requested', captured_at: '2026-07-21T00:00:00.000Z', last_generation_error: null, active_image_id: null, active_image_created_at: null };
    for (const [used, expected] of [[20, 429], [5, 409]] as const) {
      const statements: string[] = []; let creates = 0;
      const supplied = env((sql) => {
        if (sql.includes('management_principals')) return { household_id: 'household_1' };
        if (sql.includes('FROM diary_entries d JOIN recordings')) return diary;
        if (sql.includes('usage_counters')) return { used_count: used };
        return null;
      }, (sql, values) => { statements.push(sql); return { meta: { changes: 1 } } as D1Result<unknown>; });
      supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
      supplied.IMAGE_WORKFLOW = { create: async () => { creates += 1; } } as unknown as Workflow<{ async_job_id: string }>;
      const response = await app.fetch(new Request(`https://app.example.test/api/v1/diary/${diary.id}/image`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': 'signed', 'Content-Type': 'application/json' }, body: '{"version":1,"confirmed":true}' }), supplied);
      expect(response.status).toBe(expected);
      expect(creates).toBe(0);
      expect(statements.some((sql) => sql.includes('INSERT INTO async_jobs'))).toBe(false);
      if (used === 5) expect(statements.some((sql) => sql.includes("image_status = 'limit_reached'"))).toBe(true);
    }
  });

  it('画像生成は初回でも明示確認済み要求だけを受け付ける', async () => {
    const supplied = env((sql) => sql.includes('management_principals') ? { household_id: 'household_1' } : null);
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/api/v1/diary/diary_11111111111111111111111111111111/image', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': 'signed', 'Content-Type': 'application/json' },
        body: '{"version":1}',
      }),
      supplied,
    );
    expect(response.status).toBe(422);
  });

  it('絵日記SSRはmanual retry・画像上限・生成中を安全に表示する', async () => {
    const diary = { id: 'diary_11111111111111111111111111111111', household_id: 'household_1', recording_id: RECORDING_ID, diary_text: '日記', scene: null, version: 1, recording_version: 1, diary_status: 'generating', image_status: 'limit_reached', captured_at: '2026-07-21T00:00:00.000Z', last_generation_error: null, active_image_id: 'image_11111111111111111111111111111111', active_image_created_at: '2026-07-21T00:01:00.000Z' };
    const supplied = env((sql) => {
      if (sql.includes('management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM diary_entries d JOIN recordings')) return diary;
      if (sql.includes("manual_retry = 1")) return { used: 1 };
      return null;
    }, undefined, () => []);
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(new Request(`https://app.example.test/diary/${diary.id}`, { headers: { 'Cf-Access-Jwt-Assertion': 'signed' } }), supplied);
    const html = await response.text();
    expect(html).not.toContain('data-action="regenerate-diary"');
    expect(html).not.toContain('data-action="generate-image"');
    expect(html).toContain('class="busy"');
    expect(html).toContain('href="/assets/diary.css"');
    expect(html).toContain('現在の画像の作成日時: 2026-07-21T00:01:00.000Z');
  });

  it('diary.jsは初回と置換の双方で確認し確認済みフラグを送る', async () => {
    const supplied = env((sql) => sql.includes('management_principals') ? { household_id: 'household_1' } : null);
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/assets/diary.js', { headers: { 'Cf-Access-Jwt-Assertion': 'signed' } }),
      supplied,
    );
    const script = await response.text();
    expect(script).toContain('新しい画像を生成します');
    expect(script).toContain('作成日時: ');
    expect(script).toContain('confirmed:true');
  });

  it('絵日記CSSは管理認証後にCSP互換の表示ルールを返す', async () => {
    const supplied = env((sql) => sql.includes('management_principals') ? { household_id: 'household_1' } : null);
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/assets/diary.css', { headers: { 'Cf-Access-Jwt-Assertion': 'signed' } }),
      supplied,
    );
    const css = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(css).toContain('.busy::before');
    expect(css).toContain('.diary-image');
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

  it('failed初回job後のdevice process再送は新jobを作らず409へ収束する', async () => {
    const inserts: string[] = [];
    const supplied = env(
      (sql) => {
        if (sql.includes('FROM device_tokens')) return deviceRow();
        if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('failed');
        if (sql.includes("status IN ('dispatch_pending', 'dispatched', 'running')")) return null;
        if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 0 };
        if (sql.includes('ORDER BY operation_number DESC')) {
          return { id: 'job_initial', status: 'failed', correlation_id: 'corr_initial', last_error_code: 'WORKFLOW_DISPATCH_FAILED', updated_at: '2026-07-23T00:00:00.000Z', manual_retry: 0 };
        }
        return null;
      },
      (sql) => {
        if (sql.includes('INSERT INTO async_jobs')) inserts.push(sql);
        return { meta: { changes: sql.includes('INSERT INTO async_jobs') ? 0 : 1 } } as D1Result<unknown>;
      },
    );
    let workflowCreated = false;
    supplied.ANALYSIS_WORKFLOW = { create: async () => { workflowCreated = true; } } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}/process`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'RETRY_NOT_AVAILABLE' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("NOT EXISTS (SELECT 1 FROM async_jobs WHERE recording_id = ? AND job_type = 'analysis')");
    expect(workflowCreated).toBe(false);
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

  it('Workflow completeとD1非終端の不一致は結果不明へ原子的に収束する', async () => {
    const job = { id: 'job_11111111111111111111111111111111', status: 'dispatch_pending', correlation_id: 'corr_original', last_error_code: null };
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('pending');
      if (sql === 'SELECT status FROM async_jobs WHERE id = ?') return { status: 'dispatch_pending' };
      if (sql.includes('FROM async_jobs') && sql.includes("status IN ('dispatch_pending'")) return job;
      return null;
    });
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    (supplied.DB as unknown as { batch: (statements: Array<{ sql: string; values: unknown[] }>) => Promise<D1Result<unknown>[]> }).batch = async (statements) => {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 } }) as D1Result<unknown>);
    };
    supplied.ANALYSIS_WORKFLOW = {
      create: async () => {
        throw new Error('instance already exists');
      },
      get: async () => ({ status: async () => ({ status: 'complete' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}/process`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'UPSTREAM_RESULT_UNKNOWN', retryable: false });
    const sql = batches.flat().map((statement) => statement.sql).join('\n');
    expect(sql).toContain("last_error_code = ?");
    expect(sql).toContain("analysis_status = 'failed'");
    expect(batches.flat().some((statement) => statement.values.includes('UPSTREAM_RESULT_UNKNOWN'))).toBe(true);
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

  it('partial解析は安全なエラーと手動補完・再試行の案内を返す', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('partial');
      if (sql.includes('ORDER BY operation_number DESC')) {
        return {
          id: 'job_partial', status: 'succeeded', correlation_id: 'corr_partial',
          last_error_code: 'EMPTY_TRANSCRIPT', updated_at: '2026-07-23T00:00:00.000Z',
        };
      }
      return null;
    });
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      analysis_status: 'partial',
      error: {
        code: 'EMPTY_TRANSCRIPT',
        message: '一部の自動解析結果だけ取得できました。',
        retryable: false,
        correlation_id: 'corr_partial',
        next_action: '手動で内容を補完するか、上限内で再試行してください。',
      },
    });
  });

  it('partial録音のHTMLは確認・補完を表示し、編集可能な終端状態として扱う', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('partial');
      if (sql.includes('FROM transcripts')) return { raw_text: 'りんご', reviewed_text: null };
      if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 1 };
      if (sql.includes('SELECT id FROM device_tokens')) return { id: 'dev_retry' };
      if (sql.includes('ORDER BY operation_number DESC')) {
        return { id: 'job_partial', status: 'succeeded', correlation_id: 'corr_partial', last_error_code: 'EMPTY_TRANSCRIPT', updated_at: '2026-07-23T00:00:00.000Z' };
      }
      return null;
    });
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request(`https://app.example.test/recordings/${RECORDING_ID}`, { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('確認待ちです。内容を確認・補完してください。');
    expect(body).toContain('id="review-form"');
    expect(body).toContain('data-action="save"');
    expect(body).toContain('id="retry-analysis"');
    expect(body).toContain('文字起こし結果が空でした。');
    expect(body).not.toContain('処理中');
    expect(body).not.toContain('（モック）');
  });

  it('処理中HTMLは状態APIを有限間隔で確認して終端時に再描画する', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('pending');
      return null;
    });
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const page = await app.fetch(
      new Request(`https://app.example.test/recordings/${RECORDING_ID}`, { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    const html = await page.text();
    expect(html).toContain(`data-recording-id="${RECORDING_ID}"`);
    expect(html).toContain('<script src="/assets/review-detail.js"></script>');
    expect(html).not.toContain('id="review-form"');
    const asset = await app.fetch(
      new Request('https://app.example.test/assets/review-detail.js', { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    const script = await asset.text();
    expect(script).toContain("fetch('/api/v1/recordings/'");
    expect(script).toContain('let remaining=180');
    expect(script).toContain('setTimeout(poll,5000)');
    expect(html).toContain('id="processing-status"');
    expect(script).toContain('更新が停止しました。ページを再読み込みしてください。');
  });

  for (const [code, expected] of [
    ['EMPTY_WORD_CANDIDATES', '単語候補を抽出できませんでした。'],
    ['UPSTREAM_UNAVAILABLE', '自動解析サービスで問題が発生しました。'],
    ['PRIVATE_INTERNAL_DETAIL', '自動解析を完了できませんでした。取得済みの内容を確認してください。'],
  ] as const) {
    it(`partial HTMLは${code}を安全な理由へ変換する`, async () => {
      const supplied = env((sql) => {
        if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
        if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('partial');
        if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 0 };
        if (sql.includes('SELECT id FROM device_tokens')) return { id: 'dev_retry' };
        if (sql.includes('ORDER BY operation_number DESC')) {
          return { id: 'job_partial', status: 'succeeded', correlation_id: 'corr', last_error_code: code, updated_at: '2026-07-23T00:00:00.000Z' };
        }
        return null;
      });
      supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
      const response = await app.fetch(
        new Request(`https://app.example.test/recordings/${RECORDING_ID}`, { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
        supplied,
      );
      const body = await response.text();
      expect(body).toContain(expected);
      expect(body).not.toContain(code);
    });
  }

  for (const unavailable of ['attempt-limit', 'kill-switch', 'missing-token', 'manual-used'] as const) {
    it(`${unavailable}ではSSRにretryボタンを表示せず手動補完を案内する`, async () => {
      const supplied = env((sql) => {
        if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
        if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('failed');
        if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: unavailable === 'attempt-limit' ? 3 : 1 };
        if (sql.includes('SELECT id FROM device_tokens')) return unavailable === 'missing-token' ? null : { id: 'dev_retry' };
        if (sql.includes('ORDER BY operation_number DESC')) {
          return {
            id: 'job_failed', status: 'failed', correlation_id: 'corr', last_error_code: 'UPSTREAM_UNAVAILABLE',
            updated_at: '2026-07-23T00:00:00.000Z', manual_retry: unavailable === 'manual-used' ? 1 : 0,
          };
        }
        return null;
      });
      if (unavailable === 'kill-switch') supplied.DEMO_WRITE_ENABLED = 'false';
      supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
      const response = await app.fetch(
        new Request(`https://app.example.test/recordings/${RECORDING_ID}`, { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
        supplied,
      );
      const body = await response.text();
      expect(body).not.toContain('id="retry-analysis"');
      expect(body).toContain('手動で内容を補完してください。');
    });
  }

  it('管理者はpartial録音を有効tokenに紐付けて有限回だけ再解析予約できる', async () => {
    const insertValues: unknown[][] = [];
    const supplied = env(
      (sql) => {
        if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
        if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('partial');
        if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 1 };
        if (sql.includes('SELECT id FROM device_tokens')) return { id: 'dev_retry' };
        return null;
      },
      (sql, values) => {
        if (sql.includes('INSERT INTO async_jobs')) insertValues.push(values);
        return { meta: { changes: 1 } } as D1Result<unknown>;
      },
    );
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/retry-analysis`, {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token', 'Content-Type': 'application/json', 'Content-Length': '13' },
        body: '{"version":1}',
      }),
      supplied,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: 'dispatched' });
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toContain('dev_retry');
  });

  it('明示手動retryを終端後に2回目予約せず409で拒否する', async () => {
    let reservedId: string | null = null;
    let insertCount = 0;
    const supplied = env(
      (sql) => {
        if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
        if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('partial');
        if (sql.includes('ORDER BY operation_number DESC') && reservedId) {
          return { id: reservedId, status: 'succeeded', correlation_id: 'corr_manual', last_error_code: null, updated_at: '2026-07-23T00:00:00.000Z', manual_retry: 1 };
        }
        if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 1 };
        if (sql.includes('SELECT id FROM device_tokens')) return { id: 'dev_retry' };
        return null;
      },
      (sql, values) => {
        if (sql.includes('INSERT INTO async_jobs')) {
          insertCount += 1;
          reservedId = String(values[0]);
        }
        return { meta: { changes: 1 } } as D1Result<unknown>;
      },
    );
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const request = () => new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/retry-analysis`, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token', 'Content-Type': 'application/json', 'Content-Length': '13' },
      body: '{"version":1}',
    });
    expect((await app.fetch(request(), supplied)).status).toBe(202);
    expect((await app.fetch(request(), supplied)).status).toBe(409);
    expect(insertCount).toBe(1);
  });

  it('明示dispatch失敗後の同じHTTP再送でも新しいmanual job IDを作らない', async () => {
    let reservedId: string | null = null;
    const insertedIds: string[] = [];
    const supplied = env(
      (sql) => {
        if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
        if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('failed');
        if (sql.includes('ORDER BY operation_number DESC') && reservedId) {
          return { id: reservedId, status: 'failed', correlation_id: 'corr_manual', last_error_code: 'WORKFLOW_DISPATCH_FAILED', updated_at: '2026-07-23T00:00:00.000Z', manual_retry: 1 };
        }
        if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 1 };
        if (sql.includes('SELECT id FROM device_tokens')) return { id: 'dev_retry' };
        return null;
      },
      (sql, values) => {
        if (sql.includes('INSERT INTO async_jobs')) {
          reservedId = String(values[0]);
          insertedIds.push(reservedId);
        }
        return { meta: { changes: 1 } } as D1Result<unknown>;
      },
    );
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    supplied.ANALYSIS_WORKFLOW = {
      create: async () => { throw new Error('dispatch failed'); },
      get: async () => ({ status: async () => ({ status: 'errored' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    const request = () => new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/retry-analysis`, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token', 'Content-Type': 'application/json', 'Content-Length': '13' },
      body: '{"version":1}',
    });
    expect((await app.fetch(request(), supplied)).status).toBe(500);
    expect((await app.fetch(request(), supplied)).status).toBe(409);
    expect(insertedIds).toHaveLength(1);
  });

  it('dispatch_pendingのmanual retry再送は同じjob IDを再dispatchする', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('pending');
      if (sql.includes('ORDER BY operation_number DESC')) {
        return { id: 'job_manual', status: 'dispatch_pending', correlation_id: 'corr_manual', last_error_code: 'WORKFLOW_DISPATCH_UNKNOWN', updated_at: '2026-07-23T00:00:00.000Z', manual_retry: 1 };
      }
      return null;
    });
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/retry-analysis`, {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token', 'Content-Type': 'application/json', 'Content-Length': '13' },
        body: '{"version":1}',
      }),
      supplied,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ async_job_id: 'job_manual' });
  });

  it('device初回の明示dispatch失敗はjobと録音を同じbatchでfailedへ収束する', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM device_tokens')) return deviceRow();
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('failed');
      if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 0 };
      return null;
    });
    const batches: string[][] = [];
    const original = supplied.DB;
    supplied.DB = {
      ...original,
      batch: async (statements: Array<{ sql: string }>) => {
        batches.push(statements.map((statement) => statement.sql));
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;
    supplied.ANALYSIS_WORKFLOW = {
      create: async () => { throw new Error('dispatch failed'); },
      get: async () => ({ status: async () => ({ status: 'errored' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://ingest.example.test/api/v1/recordings/${RECORDING_ID}/process`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }),
      supplied,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'WORKFLOW_DISPATCH_FAILED', retryable: false });
    expect(batches.flat().some((sql) => sql.includes("UPDATE recordings SET analysis_status = 'failed'"))).toBe(true);
    expect(batches.flat().join('\n')).toContain('newer.status IN');
  });

  it('管理retryの明示dispatch失敗も新active job/attemptをguardして録音をfailedへ収束する', async () => {
    const supplied = env((sql) => {
      if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
      if (sql.includes('FROM recordings r JOIN sources')) return recordingRow('partial');
      if (sql.includes('COUNT(*) AS attempt_count')) return { attempt_count: 1 };
      if (sql.includes('SELECT id FROM device_tokens')) return { id: 'dev_retry' };
      return null;
    });
    const batches: string[][] = [];
    const original = supplied.DB;
    supplied.DB = {
      ...original,
      batch: async (statements: Array<{ sql: string }>) => {
        batches.push(statements.map((statement) => statement.sql));
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    supplied.ANALYSIS_WORKFLOW = {
      create: async () => { throw new Error('dispatch failed'); },
      get: async () => ({ status: async () => ({ status: 'terminated' }) }),
    } as unknown as Workflow<{ async_job_id: string }>;
    const response = await app.fetch(
      new Request(`https://app.example.test/api/v1/recordings/${RECORDING_ID}/retry-analysis`, {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token', 'Content-Type': 'application/json', 'Content-Length': '13' },
        body: '{"version":1}',
      }),
      supplied,
    );
    expect(response.status).toBe(500);
    const sql = batches.flat().join('\n');
    expect(sql).toContain("analysis_status = 'failed'");
    expect(sql).toContain('recordings.active_attempt_id');
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

  it('辞典HTMLではDB由来の表示名をエスケープする', async () => {
    const supplied = env(
      (sql) => (sql.includes('FROM management_principals') ? { household_id: 'household_1' } : null),
      undefined,
      (sql) =>
        sql.includes('FROM dictionary_words')
          ? [{ id: 'word_1', display_name: `<script>alert("x")</script>&'`, normalized: 'word', first_spoken_at: '2026-07-21T00:00:00.000Z', occurrence_count: 1 }]
          : [],
    );
    supplied.ACCESS_JWT_VERIFY = async () => ({ accessSubject: 'management-subject' });
    const response = await app.fetch(
      new Request('https://app.example.test/dictionary', { headers: { 'Cf-Access-Jwt-Assertion': 'signed-test-token' } }),
      supplied,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    expect(body).not.toContain('<script>alert');
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
