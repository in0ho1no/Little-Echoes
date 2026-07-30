export interface DeviceIdentity {
  id: string;
  householdId: string;
  sourceId: string;
  sourceType: 'pc' | 'atom' | 'sample';
}

export interface ManagementIdentity {
  accessSubject: string;
  householdId: string;
}

export interface VerifiedAccessIdentity {
  accessSubject: string;
}

export interface WorkflowParams {
  async_job_id: string;
}

export type Env = Omit<
  CloudflareBindings,
  'ANALYSIS_WORKFLOW' | 'DELETE_WORKFLOW' | 'DIARY_WORKFLOW' | 'IMAGE_WORKFLOW' | 'IMAGE_CLEANUP_WORKFLOW' | 'DEMO_WRITE_ENABLED' | 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ADMIN_HOST' | 'INGEST_HOST'
> & {
  ANALYSIS_WORKFLOW: Workflow<WorkflowParams>;
  DELETE_WORKFLOW: Workflow<WorkflowParams>;
  DIARY_WORKFLOW: Workflow<WorkflowParams>;
  IMAGE_WORKFLOW: Workflow<WorkflowParams>;
  IMAGE_CLEANUP_WORKFLOW: Workflow<WorkflowParams>;
  DEVICE_TOKEN_HMAC_SECRET: string;
  DEMO_WRITE_ENABLED: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_HOST: string;
  INGEST_HOST: string;
  /** Secret binding only. It is never returned, logged, or stored in D1. */
  OPENAI_API_KEY?: string;
  ACCESS_JWT_VERIFY?: (jwt: string, env: Env) => Promise<VerifiedAccessIdentity | null>;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  correlation_id: string;
  next_action: string;
}
