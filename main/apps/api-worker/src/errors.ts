import type { ApiErrorBody } from './types';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

export function newCorrelationId(): string {
  return `corr_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function errorBody(
  correlationId: string,
  code: string,
  message: string,
  retryable = false,
  nextAction = '要求内容を確認してください。',
): ApiErrorBody {
  return { code, message, retryable, correlation_id: correlationId, next_action: nextAction };
}
