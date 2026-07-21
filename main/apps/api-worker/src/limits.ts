export const MAX_AUDIO_BYTES = 1_100_000;
export const MAX_DURATION_SECONDS = 20;
export const MAX_RECORDINGS_PER_UTC_DAY = 30;
export const DEMO_WRITE_DEADLINE = '2026-08-31T15:00:00.000Z';
export const RECORDING_RETENTION_DAYS = 30;

export function isDemoWriteAllowed(enabled: string, now = new Date()): boolean {
  return enabled === 'true' && now.getTime() < Date.parse(DEMO_WRITE_DEADLINE);
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function normalizeUtcRfc3339(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const timestamp = Date.parse(canonical);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) return null;
  if (timestamp < Date.parse('2000-01-01T00:00:00.000Z') || timestamp > Date.parse('2099-12-31T23:59:59.999Z')) return null;
  return canonical;
}

export function retentionDeleteAfter(now: Date): string {
  return new Date(now.getTime() + RECORDING_RETENTION_DAYS * 86_400_000).toISOString();
}
