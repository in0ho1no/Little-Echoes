import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 依存を追加せずに重要述語へ限定ミュータントを適用し、対象テストが失敗する
// （＝退行を検出できる）ことを確認する。findはドリフト検出のため出現1回を要求する。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MUTANTS = [
  {
    name: 'reserve-strict-changes-comparison',
    file: 'src/diary.ts',
    find: '>= 1) return attempt;',
    replace: '=== 1) return attempt;',
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'stale-attempt-left-running',
    file: 'src/diary.ts',
    find: "SET status = 'failed', error_code = 'STEP_REEXECUTED'",
    replace: "SET status = 'running', error_code = 'STEP_REEXECUTED'",
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'image-timeout-shared-with-text',
    file: 'src/diary.ts',
    find: '{ timeout: IMAGE_OPENAI_REQUEST_TIMEOUT_MILLISECONDS }',
    replace: '{ timeout: OPENAI_REQUEST_TIMEOUT_MILLISECONDS }',
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'image-timeout-value-regression',
    file: 'src/limits.ts',
    find: 'IMAGE_OPENAI_REQUEST_TIMEOUT_MILLISECONDS = 120_000',
    replace: 'IMAGE_OPENAI_REQUEST_TIMEOUT_MILLISECONDS = 30_000',
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'manual-retry-release-disabled',
    file: 'src/diary.ts',
    find: '.bind(job.id, code, releaseManualRetry ? 1 : 0)',
    replace: '.bind(job.id, code, 0)',
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'diary-guard-dropped-from-image-delete',
    file: 'src/app.ts',
    find: "WHERE j.recording_id = ? AND j.job_type IN ('diary','image')",
    replace: "WHERE j.recording_id = ? AND j.job_type IN ('image')",
    tests: ['test/app.test.ts'],
  },
  {
    name: 'all-errors-mapped-to-version-conflict',
    file: 'src/review.ts',
    find: "error.message.includes('recording_tombstones')",
    replace: "error.message.includes('')",
    tests: ['test/app.test.ts'],
  },
];

let failures = 0;
for (const mutant of MUTANTS) {
  const path = join(root, mutant.file);
  const original = readFileSync(path, 'utf-8');
  const occurrences = original.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    console.error(`[drift] ${mutant.name}: ${mutant.file} 内の対象文字列が1回でなく${occurrences}回出現。findを更新すること。`);
    failures += 1;
    continue;
  }
  writeFileSync(path, original.replace(mutant.find, mutant.replace), 'utf-8');
  try {
    const run = spawnSync('pnpm', ['vitest', 'run', ...mutant.tests], { cwd: root, shell: true, encoding: 'utf-8' });
    if (run.status === 0) {
      console.error(`[survived] ${mutant.name}: 対象テストがミュータントを検出できなかった。`);
      failures += 1;
    } else {
      console.log(`[killed] ${mutant.name}`);
    }
  } finally {
    writeFileSync(path, original, 'utf-8');
  }
}

if (failures > 0) {
  console.error(`${failures}件のミュータントが生存またはドリフトした。`);
  process.exit(1);
}
console.log(`全${MUTANTS.length}件のミュータントを検出できた。`);
