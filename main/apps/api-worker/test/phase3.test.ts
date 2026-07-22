import { describe, expect, it } from 'vitest';

import { app, isNewForDisplay } from '../src/app';
import type { Env } from '../src/types';

const RECORDING_ID = 'rec_11111111111111111111111111111111';

function recording(analysisStatus = 'ready', reviewStatus = 'pending'): Record<string, string | number | null> {
  return {
    id: RECORDING_ID,
    household_id: 'household_1',
    source_id: 'source_1',
    source_type: 'pc',
    audio_sha256: '0'.repeat(64),
    audio_object_key: `recordings/${RECORDING_ID}/audio.wav`,
    analysis_status: analysisStatus,
    review_status: reviewStatus,
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

function testEnv(sqlLog: string[], suppliedRecording: Record<string, string | number | null> | null = recording(), batchChanges = 1): Env {
  const database = {
    prepare: (sql: string) => {
      const bound = {
        __sql: sql,
        first: async () => {
          sqlLog.push(sql);
          if (sql.includes('FROM management_principals')) return { household_id: 'household_1' };
          if (sql.includes('FROM recordings r JOIN sources')) return suppliedRecording;
          return null;
        },
        all: async () => {
          sqlLog.push(sql);
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return { bind: (..._values: unknown[]) => bound };
    },
    batch: async (statements: unknown[]) => {
      sqlLog.push(...statements.map((statement) => (statement as { __sql?: string }).__sql ?? ''));
      return statements.map(() => ({ meta: { changes: batchChanges } }));
    },
  } as unknown as D1Database;
  return {
    DB: database,
    PRIVATE_MEDIA: {} as R2Bucket,
    ANALYSIS_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DELETE_WORKFLOW: {} as Workflow<{ async_job_id: string }>,
    DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64),
    DEMO_WRITE_ENABLED: 'true',
    ACCESS_TEAM_DOMAIN: 'team.example.test',
    ACCESS_AUD: 'aud',
    ADMIN_HOST: 'app.example.test',
    INGEST_HOST: 'ingest.example.test',
    ACCESS_JWT_VERIFY: async () => ({ accessSubject: 'management-subject' }),
  };
}

function reviewBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    reviewed_text: '',
    words: [{ display_name: 'りんご', normalized: 'りんご', new_override: 'auto' }],
    captured_at: '2026-07-20T00:00:00.000Z',
    captured_timezone: 'Asia/Tokyo',
    scene: '朝食',
    parent_note: 'りんごを見た',
    ...overrides,
  });
}

function reviewRequest(path: string, method: 'PATCH' | 'POST', body: string, declaredLength?: number): Request {
  return new Request(`https://app.example.test${path}`, {
    method,
    headers: {
      'Cf-Access-Jwt-Assertion': 'signed-test-token',
      'Content-Type': 'application/json',
      'Content-Length': String(declaredLength ?? new TextEncoder().encode(body).byteLength),
    },
    body,
  });
}

describe('Phase 3 確認・承認API', () => {
  it('同じ正規化単語を重複入力するとD1に到達せず拒否する', async () => {
    const sqlLog: string[] = [];
    const body = reviewBody({
      words: [
        { display_name: 'りんご', normalized: 'りんご', new_override: 'auto' },
        { display_name: 'リンゴ', normalized: 'りんご', new_override: 'auto' },
      ],
    });
    const response = await app.fetch(reviewRequest(`/api/v1/recordings/${RECORDING_ID}/review`, 'PATCH', body), testEnv(sqlLog));
    expect(response.status).toBe(422);
    expect(sqlLog.filter((sql) => sql.includes('FROM recordings r JOIN sources'))).toHaveLength(0);
  });

  it('Phase 6の画像指定を厳格JSONとして拒否する', async () => {
    const sqlLog: string[] = [];
    const response = await app.fetch(
      reviewRequest(`/api/v1/recordings/${RECORDING_ID}/approve`, 'POST', reviewBody({ generate_image: true })),
      testEnv(sqlLog),
    );
    expect(response.status).toBe(422);
    expect(sqlLog.filter((sql) => sql.includes('FROM recordings r JOIN sources'))).toHaveLength(0);
  });

  it('小さく偽装したContent-Lengthでも実本文が16KiBを超えれば拒否する', async () => {
    const sqlLog: string[] = [];
    const body = reviewBody({ reviewed_text: 'あ'.repeat(6_000) });
    const response = await app.fetch(
      reviewRequest(`/api/v1/recordings/${RECORDING_ID}/review`, 'PATCH', body, 1),
      testEnv(sqlLog),
    );
    expect(response.status).toBe(422);
    expect(sqlLog.filter((sql) => sql.includes('FROM recordings r JOIN sources'))).toHaveLength(0);
  });

  it('NEW表示だけをoverrideし、時系列first値そのものは上書きしない', () => {
    expect(isNewForDisplay({ is_first: 0, new_override: 'force_new' })).toBe(true);
    expect(isNewForDisplay({ is_first: 1, new_override: 'force_not_new' })).toBe(false);
    expect(isNewForDisplay({ is_first: 1, new_override: 'auto' })).toBe(true);
  });

  it('処理中の録音を承認せず、削除や日記ジョブを予約しない', async () => {
    const sqlLog: string[] = [];
    const response = await app.fetch(
      reviewRequest(`/api/v1/recordings/${RECORDING_ID}/approve`, 'POST', reviewBody()),
      testEnv(sqlLog, recording('transcribing')),
    );
    expect(response.status).toBe(409);
    expect(sqlLog.some((sql) => sql.includes('INSERT INTO async_jobs'))).toBe(false);
  });

  it('古いversionの保存は、単語や日時を上書きせず競合として返す', async () => {
    const sqlLog: string[] = [];
    const response = await app.fetch(
      reviewRequest(`/api/v1/recordings/${RECORDING_ID}/review`, 'PATCH', reviewBody()),
      testEnv(sqlLog, recording(), 0),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('空文字起こし・候補1件を承認し、日記下書きと辞典再計算を同一D1 batchへ入れる', async () => {
    const sqlLog: string[] = [];
    const response = await app.fetch(
      reviewRequest(`/api/v1/recordings/${RECORDING_ID}/approve`, 'POST', reviewBody()),
      testEnv(sqlLog),
    );
    expect(response.status).toBe(200);
    const combined = sqlLog.join('\n');
    expect(combined).toContain('INSERT INTO diary_entries');
    expect(combined).toContain('ROW_NUMBER() OVER');
    expect(combined).toContain('INSERT INTO word_occurrences');
    expect(combined).not.toContain("'diary', 'dispatch_pending'");
  });

  it('承認済み録音のPATCH日時編集も発話を再集計し、日時監査を同一batchへ入れる', async () => {
    const sqlLog: string[] = [];
    const response = await app.fetch(
      reviewRequest(`/api/v1/recordings/${RECORDING_ID}/review`, 'PATCH', reviewBody()),
      testEnv(sqlLog, recording('ready', 'approved')),
    );
    expect(response.status).toBe(200);
    const combined = sqlLog.join('\n');
    expect(combined).toContain('DELETE FROM word_occurrences');
    expect(combined).toContain('ROW_NUMBER() OVER');
    expect(combined).toContain("'captured_at_changed'");
  });

  it('別世帯の録音は存在を返さない', async () => {
    const sqlLog: string[] = [];
    const response = await app.fetch(
      reviewRequest(`/api/v1/recordings/${RECORDING_ID}/review`, 'PATCH', reviewBody()),
      testEnv(sqlLog, null),
    );
    expect(response.status).toBe(404);
  });
});
