import { describe, expect, it } from 'vitest';

import { isDemoWriteAllowed, normalizeUtcRfc3339, retentionDeleteAfter } from '../src/limits';

describe('デモ書き込み期限', () => {
  it('2026-09-01 00:00 JST以降はフラグが有効でも書き込みを拒否する', () => {
    expect(isDemoWriteAllowed('true', new Date('2026-08-31T14:59:59.999Z'))).toBe(true);
    expect(isDemoWriteAllowed('true', new Date('2026-08-31T15:00:00.000Z'))).toBe(false);
    expect(isDemoWriteAllowed('false', new Date('2026-07-21T00:00:00.000Z'))).toBe(false);
    expect(isDemoWriteAllowed('TRUE', new Date('2026-07-21T00:00:00.000Z'))).toBe(false);
  });
});

describe('時刻境界', () => {
  it('RFC 3339 UTCだけを受理してミリ秒精度へ正規化する', () => {
    expect(normalizeUtcRfc3339('2026-07-21T01:02:03Z')).toBe('2026-07-21T01:02:03.000Z');
    expect(normalizeUtcRfc3339('2026-07-21T01:02:03.4Z')).toBe('2026-07-21T01:02:03.400Z');
    expect(normalizeUtcRfc3339('2026-07-21')).toBeNull();
    expect(normalizeUtcRfc3339('2026-07-21T01:02:03+09:00')).toBeNull();
    expect(normalizeUtcRfc3339('2026-02-30T01:02:03Z')).toBeNull();
  });

  it('保持期限を作成時刻から30日後に固定する', () => {
    expect(retentionDeleteAfter(new Date('2026-07-21T00:00:00.000Z'))).toBe('2026-08-20T00:00:00.000Z');
  });
});
