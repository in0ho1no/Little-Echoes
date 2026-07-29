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
    const testSources = readdirSync(testDirectory)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(testDirectory, name), 'utf-8'))
      .join('\n');
    for (const title of scenarios) {
      expect(testSources, `シナリオに対応するテストがありません: ${title}`).toContain(`'${title}'`);
    }
  });
});
