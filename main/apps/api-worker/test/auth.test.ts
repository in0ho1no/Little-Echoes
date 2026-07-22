import { describe, expect, it } from 'vitest';

import { authenticateDevice, constantTimeEqualHex, hmacToken } from '../src/auth';
import type { Env } from '../src/types';

function database(row: unknown): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
  } as unknown as D1Database;
}

describe('デバイストークン認証', () => {
  it('HMACを一定時間比較し、有効な束縛だけを返す', async () => {
    const secret = 'x'.repeat(64);
    const token = 'a'.repeat(43);
    const tokenHmac = await hmacToken(token, secret);
    const env = { DB: database({ id: 'dev_1', household_id: 'household_1', source_id: 'source_1', source_type: 'pc', token_hmac: tokenHmac }), DEVICE_TOKEN_HMAC_SECRET: secret } as Env;
    const identity = await authenticateDevice(new Request('https://ingest.example/api', { headers: { Authorization: `Bearer ${token}` } }), env);
    expect(identity).toMatchObject({ householdId: 'household_1', sourceId: 'source_1', sourceType: 'pc' });
    expect(constantTimeEqualHex(tokenHmac, tokenHmac)).toBe(true);
    expect(constantTimeEqualHex(tokenHmac, '0'.repeat(64))).toBe(false);
  });

  it('期限切れ・不正形式のトークンを拒否する', async () => {
    const env = { DB: database(null), DEVICE_TOKEN_HMAC_SECRET: 'x'.repeat(64) } as Env;
    await expect(authenticateDevice(new Request('https://ingest.example/api', { headers: { Authorization: 'Bearer short' } }), env)).resolves.toBeNull();
    await expect(authenticateDevice(new Request('https://ingest.example/api', { headers: { Authorization: `Bearer ${'a'.repeat(43)}` } }), env)).resolves.toBeNull();
  });

  it('last_used_atの書込みを1時間に1回へ抑制する', async () => {
    const secret = 'x'.repeat(64);
    const token = 'b'.repeat(43);
    const tokenHmac = await hmacToken(token, secret);
    const updates: { sql: string; values: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => ({ id: 'dev_1', household_id: 'household_1', source_id: 'source_1', source_type: 'pc', token_hmac: tokenHmac }),
          run: async () => {
            updates.push({ sql, values });
            return { meta: { changes: 0 } };
          },
        }),
      }),
    } as unknown as D1Database;
    const now = new Date('2026-07-21T12:00:00.000Z');
    await authenticateDevice(new Request('https://ingest.example/api', { headers: { Authorization: `Bearer ${token}` } }), { DB: db, DEVICE_TOKEN_HMAC_SECRET: secret } as Env, now);
    expect(updates[0]?.sql).toContain('(last_used_at IS NULL OR last_used_at <= ?)');
    expect(updates[0]?.values).toEqual(['2026-07-21T12:00:00.000Z', 'dev_1', '2026-07-21T11:00:00.000Z']);
  });
});
