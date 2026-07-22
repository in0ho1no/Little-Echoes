import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { verifyAccessJwtWithKeySet } from '../src/access-jwt';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUDIENCE = 'application-audience';

async function fixture(): Promise<{ sign: (options?: { exp?: boolean; sub?: boolean; issuer?: string; audience?: string }) => Promise<string>; jwks: ReturnType<typeof createLocalJWKSet> }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return {
    jwks,
    sign: async (options = {}) => {
      let jwt = new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test-key' });
      jwt = jwt.setIssuer(options.issuer ?? ISSUER).setAudience(options.audience ?? AUDIENCE);
      if (options.sub !== false) jwt = jwt.setSubject('access-subject');
      if (options.exp !== false) jwt = jwt.setExpirationTime('5 minutes');
      return jwt.sign(privateKey);
    },
  };
}

describe('Cloudflare Access JWT検証', () => {
  it('署名・iss・aud・exp・subが揃ったJWTだけを受理する', async () => {
    const { sign, jwks } = await fixture();
    await expect(verifyAccessJwtWithKeySet(await sign(), ISSUER, AUDIENCE, jwks)).resolves.toEqual({ accessSubject: 'access-subject' });
    await expect(verifyAccessJwtWithKeySet(await sign({ exp: false }), ISSUER, AUDIENCE, jwks)).resolves.toBeNull();
    await expect(verifyAccessJwtWithKeySet(await sign({ sub: false }), ISSUER, AUDIENCE, jwks)).resolves.toBeNull();
    await expect(verifyAccessJwtWithKeySet(await sign({ issuer: `${ISSUER}.invalid` }), ISSUER, AUDIENCE, jwks)).resolves.toBeNull();
    await expect(verifyAccessJwtWithKeySet(await sign({ audience: 'wrong-audience' }), ISSUER, AUDIENCE, jwks)).resolves.toBeNull();
  });

  it('RS256以外のアルゴリズムで署名されたJWTを拒否する', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'es-key';
    const esJwks = createLocalJWKSet({ keys: [publicJwk] });
    const esToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('access-subject')
      .setExpirationTime('5 minutes')
      .sign(privateKey);
    await expect(verifyAccessJwtWithKeySet(esToken, ISSUER, AUDIENCE, esJwks)).resolves.toBeNull();
  });
});
