import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 実D1のmeta.changesはトリガーの書き込み行数を加算する（Phase 2で本番実証、修正44f7ad7。
// Phase 6レビューで再発）。ローカルのモックやテストではchanges=1が返るため退行を検出でき
// ない。厳密比較を静的に禁止し、「書き込み成立 >= 1」「未書き込み === 0」だけを許可する。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('D1 meta.changesガード', () => {
  it('forbids strict meta.changes comparisons that break under D1 triggers', () => {
    const sourceDirectory = join(root, 'src');
    const violations: string[] = [];
    for (const name of readdirSync(sourceDirectory).filter((entry) => entry.endsWith('.ts'))) {
      const lines = readFileSync(join(sourceDirectory, name), 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes('meta.changes') && /[!=]== 1\b/.test(line)) {
          violations.push(`src/${name}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, 'meta.changesはトリガー書き込みを含むため、>= 1 か === 0 で判定すること。').toEqual([]);
  });
});
