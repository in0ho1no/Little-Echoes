import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

import type { Env, VerifiedAccessIdentity } from './types';

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function accessIssuer(teamDomain: string): string | null {
  const hostname = teamDomain.toLowerCase();
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(hostname) ? `https://${hostname}` : null;
}

export async function verifyAccessJwtWithKeySet(
  assertion: string,
  issuer: string,
  audience: string,
  jwks: JWTVerifyGetKey,
): Promise<VerifiedAccessIdentity | null> {
  try {
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer,
      audience,
      requiredClaims: ['iss', 'aud', 'exp', 'sub'],
    });
    const subject = typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 256 ? payload.sub : null;
    return subject ? { accessSubject: subject } : null;
  } catch {
    return null;
  }
}

export async function verifyAccessJwt(assertion: string, env: Env): Promise<VerifiedAccessIdentity | null> {
  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  if (!issuer || !env.ACCESS_AUD) {
    return null;
  }
  const jwks = jwksByIssuer.get(issuer) ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  jwksByIssuer.set(issuer, jwks);
  return verifyAccessJwtWithKeySet(assertion, issuer, env.ACCESS_AUD, jwks);
}
