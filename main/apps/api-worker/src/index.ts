import { app, ensureMissingInitialDiaryJobs } from './app';
import { DeleteWorkflow, scheduleRetentionCleanup } from './delete';
import { DiaryWorkflow, ImageWorkflow, reconcileGenerationDispatch, reconcileOrphanImageObjects } from './diary';
import { ImageCleanupWorkflow, scheduleImageCleanup, sweepUnreferencedImageObjects } from './image-cleanup';
import { AnalysisWorkflow } from './workflow';
import type { Env } from './types';

// wrangler.toml の crons と一致させる。日次分だけが保持期限削除と孤児スイープを含む —
// 保持期限削除の1日1回・最大10件の規律を毎時トリガーで破らないため、既知の日次cron文字列
// と厳密一致した場合にのみ実行する。
export const DAILY_FULL_CRON = '17 3 * * *';

export default {
  fetch: app.fetch,
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    const tasks = [
      scheduleImageCleanup(env),
      reconcileGenerationDispatch(env),
      reconcileOrphanImageObjects(env),
      ensureMissingInitialDiaryJobs(env),
    ];
    if (event.cron === DAILY_FULL_CRON) {
      tasks.push(scheduleRetentionCleanup(env), sweepUnreferencedImageObjects(env));
    }
    ctx.waitUntil(Promise.allSettled(tasks));
  },
};
export { AnalysisWorkflow, DeleteWorkflow, DiaryWorkflow, ImageWorkflow, ImageCleanupWorkflow };
