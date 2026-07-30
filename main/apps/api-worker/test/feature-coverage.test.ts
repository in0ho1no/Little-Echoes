import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// featureの各Scenarioに、実行される同名it()が正確に1件あることを検証する。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function extractScenarioTitles(source: string): string[] {
  // checkout時のEOL変換（CRLF）に依存しないよう\r?\nで分割する。\rが残るとJSの`.`は
  // \rに一致しないため、行末アンカー付きの抽出が全件不一致になる。
  return source
    .split(/\r?\n/)
    .map((line) => /^\s*Scenario: (.+)$/.exec(line)?.[1]?.trim())
    .filter((title): title is string => Boolean(title));
}

function extractDirectItTitles(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'it'
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      titles.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return titles;
}

function countTitles(titles: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
  return counts;
}

function findCoverageViolations(scenarios: string[], tests: string[]): string[] {
  const scenarioCounts = countTitles(scenarios);
  const testCounts = countTitles(tests);
  const violations: string[] = [];
  for (const [title, scenarioCount] of scenarioCounts) {
    if (scenarioCount !== 1) {
      violations.push(`Scenarioタイトルが${scenarioCount}件あります: ${title}`);
      continue;
    }
    const testCount = testCounts.get(title) ?? 0;
    if (testCount !== 1) violations.push(`同名の実行対象it()が${testCount}件あります: ${title}`);
  }
  return violations;
}

describe('Gherkinシナリオ対応', () => {
  it('featureファイルの全Scenarioが同名のテストとして実装されている', () => {
    const featureDirectory = join(root, 'features');
    const scenarios = readdirSync(featureDirectory)
      .filter((name) => name.endsWith('.feature'))
      .flatMap((name) => extractScenarioTitles(readFileSync(join(featureDirectory, name), 'utf-8')));
    expect(scenarios.length).toBeGreaterThan(0);
    const testDirectory = join(root, 'test');
    const tests = listTypeScriptFiles(testDirectory)
      .flatMap((path) => extractDirectItTitles(readFileSync(path, 'utf-8'), path));
    expect(findCoverageViolations(scenarios, tests)).toEqual([]);
  });

  it('ignores commented tests and rejects duplicate implementations', () => {
    const tests = extractDirectItTitles(`
      /*
      it('target scenario', () => undefined);
      */
      // it('target scenario', () => undefined);
      it('target scenario', () => undefined);
      it('target scenario', () => undefined);
    `, 'synthetic.test.ts');
    expect(tests).toEqual(['target scenario', 'target scenario']);
    expect(findCoverageViolations(['target scenario'], tests)).toEqual([
      '同名の実行対象it()が2件あります: target scenario',
    ]);
    expect(findCoverageViolations(['target scenario', 'target scenario'], ['target scenario'])).toEqual([
      'Scenarioタイトルが2件あります: target scenario',
    ]);
  });
});
