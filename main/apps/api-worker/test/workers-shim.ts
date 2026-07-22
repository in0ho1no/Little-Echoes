export class WorkflowEntrypoint<Environment, Params> {
  readonly env: Environment;

  constructor(ctx: unknown, env: Environment) {
    void ctx;
    this.env = env;
  }

  async run(_event: { payload: Params }, _step: unknown): Promise<void> {
    throw new Error('WorkflowEntrypoint test shim cannot run directly.');
  }
}
