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
    // 全タスク完了後に失敗を集約して投げる — allSettledの黙殺はscheduled invocationを
    // 成功として記録し、保持期限削除等の失敗が監視から見えなくなるため。
    ctx.waitUntil(Promise.allSettled(tasks).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((failure) => failure.reason as Error), `${failures.length} scheduled task(s) failed`);
      }
    }));
  },
};
export { AnalysisWorkflow, DeleteWorkflow, DiaryWorkflow, ImageWorkflow, ImageCleanupWorkflow };
