import { app, ensureMissingInitialDiaryJobs } from './app';
import { DeleteWorkflow, scheduleRetentionCleanup } from './delete';
import { DiaryWorkflow, ImageWorkflow, reconcileGenerationDispatch, reconcileOrphanImageObjects } from './diary';
import { ImageCleanupWorkflow, scheduleImageCleanup } from './image-cleanup';
import { AnalysisWorkflow } from './workflow';
import type { Env } from './types';

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(Promise.all([
      scheduleRetentionCleanup(env),
      scheduleImageCleanup(env),
      reconcileGenerationDispatch(env),
      reconcileOrphanImageObjects(env),
      ensureMissingInitialDiaryJobs(env),
    ]));
  },
};
export { AnalysisWorkflow, DeleteWorkflow, DiaryWorkflow, ImageWorkflow, ImageCleanupWorkflow };
