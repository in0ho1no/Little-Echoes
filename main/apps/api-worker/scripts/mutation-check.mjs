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
    find: "error.message.includes('NOT NULL constraint failed: recording_tombstones')",
    replace: "error.message.includes('recording_tombstones')",
    tests: ['test/app.test.ts'],
  },
  {
    name: 'takeover-claims-sent-attempts',
    file: 'src/diary.ts',
    find: '.bind(now, job.id, `${kind}_generation`, job.id),',
    replace: '.bind(now, job.id, `${kind}_generation_sent`, job.id),',
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'deadline-comparison-inverted',
    file: 'src/diary.ts',
    find: 'job.created_at <= deadlineBefore',
    replace: 'job.created_at > deadlineBefore',
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'daily-cron-branch-inverted',
    file: 'src/index.ts',
    find: 'event.cron === DAILY_FULL_CRON',
    replace: 'event.cron !== DAILY_FULL_CRON',
    tests: ['test/index.test.ts'],
  },
  {
    name: 'sweep-cursor-never-advances',
    file: 'src/image-cleanup.ts',
    find: 'listed.truncated ? listed.objects.at(-1)?.key ?? null : null',
    replace: 'null',
    tests: ['test/image-cleanup.test.ts'],
  },
  {
    name: 'deadline-does-not-shortcut-counter',
    file: 'src/diary.ts',
    find: 'if (pastDeadline || job.dispatch_reconcile_count >= 2) {',
    replace: 'if (job.dispatch_reconcile_count >= 2) {',
    tests: ['test/diary.test.ts'],
  },
  {
    name: 'cleanup-deadline-ignored',
    file: 'src/image-cleanup.ts',
    find: 'if (job.created_at <= deadlineBefore) {',
    replace: 'if (job.created_at > deadlineBefore) {',
    tests: ['test/image-cleanup.test.ts'],
  },
  {
    name: 'recordings-guard-bound-to-diary-id',
    file: 'src/app.ts',
    find: ', kind, diary.recording_id, diary.recording_id, householdId,',
    replace: ', kind, diary.recording_id, diary.id, householdId,',
    tests: ['test/app.test.ts'],
  },
  {
    name: 'strict-changes-comparison-reintroduced',
    file: 'src/workflow.ts',
    find: "(results[1]?.meta.changes ?? 0) >= 1 ? 'converged' : 'active'",
    replace: "(results[1]?.meta.changes ?? 0) === 1 ? 'converged' : 'active'",
    tests: ['test/d1-changes-guard.test.ts'],
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
    // shell経由にしない — シェル解釈を挟むと環境変数・設定が伝播しsemgrep(CWE-78)の監査対象になる。
    // Windowsの.cmdシム解決も不要になるよう、vitestのbinを現在のNodeで直接実行する。
    const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
    const run = spawnSync(process.execPath, [vitestBin, 'run', ...mutant.tests], { cwd: root, encoding: 'utf-8' });
    if (run.error || run.status === null) {
      const reason = run.error?.message ?? `終了ステータスなし（signal: ${run.signal ?? 'unknown'}）`;
      console.error(`[harness-error] ${mutant.name}: Vitestを正常に起動・完了できなかった: ${reason}`);
      failures += 1;
    } else if (run.status === 0) {
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
