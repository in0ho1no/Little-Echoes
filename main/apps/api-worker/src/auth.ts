import type { DeviceIdentity, Env, ManagementIdentity } from './types';

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function constantTimeEqualHex(left: string, right: string): boolean {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function hmacToken(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return Array.from(new Uint8Array(signature), (part) => part.toString(16).padStart(2, '0')).join('');
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{43,512})$/);
  return match?.[1] ?? null;
}

interface DeviceTokenRow {
  id: string;
  household_id: string;
  source_id: string;
  source_type: DeviceIdentity['sourceType'];
  token_hmac: string;
}

export async function authenticateDevice(request: Request, env: Env, now = new Date()): Promise<DeviceIdentity | null> {
  const token = extractBearerToken(request);
  if (!token || !env.DEVICE_TOKEN_HMAC_SECRET) {
    return null;
  }
  const tokenHmac = await hmacToken(token, env.DEVICE_TOKEN_HMAC_SECRET);
  const row = await env.DB.prepare(
    `SELECT dt.id, dt.household_id, dt.source_id, dt.token_hmac, s.source_type
       FROM device_tokens dt
       JOIN sources s ON s.household_id = dt.household_id AND s.id = dt.source_id
      WHERE dt.token_hmac = ? AND dt.revoked_at IS NULL AND dt.expires_at > ?`,
  )
    .bind(tokenHmac, now.toISOString())
    .first<DeviceTokenRow>();
  if (!row || !constantTimeEqualHex(tokenHmac, row.token_hmac)) {
    return null;
  }
  const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  await env.DB.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)').bind(now.toISOString(), row.id, oneHourAgo).run();
  return { id: row.id, householdId: row.household_id, sourceId: row.source_id, sourceType: row.source_type };
}

interface PrincipalRow {
  household_id: string;
}

export async function authenticateManagement(request: Request, env: Env): Promise<ManagementIdentity | null> {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || !env.ACCESS_JWT_VERIFY) {
    return null;
  }
  const verified = await env.ACCESS_JWT_VERIFY(assertion, env);
  if (!verified) {
    return null;
  }
  const principal = await env.DB.prepare(
    'SELECT household_id FROM management_principals WHERE access_subject = ? AND revoked_at IS NULL',
  )
    .bind(verified.accessSubject)
    .first<PrincipalRow>();
  return principal ? { accessSubject: verified.accessSubject, householdId: principal.household_id } : null;
}
