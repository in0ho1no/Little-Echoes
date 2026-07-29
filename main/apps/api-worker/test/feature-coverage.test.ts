import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// featureファイルは仕様として人が読み、本テストがテスト実装との1:1対応を機械検証する。
// 依存を増やさないため、Scenarioタイトルの抽出と突合だけを自前で行う。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Gherkinシナリオ対応', () => {
  it('featureファイルの全Scenarioが同名のテストとして実装されている', () => {
    const featureDirectory = join(root, 'features');
    const scenarios = readdirSync(featureDirectory)
      .filter((name) => name.endsWith('.feature'))
      .flatMap((name) =>
        readFileSync(join(featureDirectory, name), 'utf-8')
          .split('\n')
          .map((line) => /^\s*Scenario: (.+)$/.exec(line)?.[1]?.trim())
          .filter((title): title is string => Boolean(title)),
      );
    expect(scenarios.length).toBeGreaterThan(0);
    const testDirectory = join(root, 'test');
    const titles = new Set<string>();
    for (const name of readdirSync(testDirectory).filter((entry) => entry.endsWith('.ts'))) {
      const source = readFileSync(join(testDirectory, name), 'utf-8');
      // コメントや重複文字列では通過しないよう、it()の実テスト名だけを抽出して突合する。
      const pattern = /\bit\('((?:[^'\\]|\\.)*)'/g;
      let match;
      while ((match = pattern.exec(source)) !== null) titles.add(match[1]);
    }
    for (const title of scenarios) {
      expect(titles.has(title), `シナリオに対応するit()テストがありません: ${title}`).toBe(true);
    }
  });
});
