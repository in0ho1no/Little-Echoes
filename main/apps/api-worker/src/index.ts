import { app } from './app';
import { DeleteWorkflow, scheduleRetentionCleanup } from './delete';
import { AnalysisWorkflow } from './workflow';
import type { Env } from './types';

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(scheduleRetentionCleanup(env));
  },
};
export { AnalysisWorkflow, DeleteWorkflow };
