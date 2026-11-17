import { beforeAll, describe, expect, it } from 'vitest';
import { AccessVerifier, JWKS_MIN_REFETCH_MS, normalizeTeamDomain } from './access.ts';
import { TEST_AUD, TEST_TEAM, generateTestKey, jwksStub, signJwt, validClaims } from './testing/jwt.ts';
import type { TestKey } from './testing/jwt.ts';

let keyA: TestKey;
let keyB: TestKey;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const config = { teamDomain: TEST_TEAM, aud: TEST_AUD };

beforeAll(async () => {
  keyA = await generateTestKey('kid-a');
  keyB = await generateTestKey('kid-b');
});

function verifier(keys: () => TestKey[], now: () => number = () => NOW) {
  const stub = jwksStub(keys);
  return { v: new AccessVerifier({ fetchJwks: stub.fetch, now }), urls: stub.urls };
}

describe('AccessVerifier', () => {
  it('accepts a valid RS256 token and fetches the team JWKS', async () => {
    const { v, urls } = verifier(() => [keyA]);
    const result = await v.verify(await signJwt(keyA, validClaims(NOW)), config);
    expect(result).toEqual({ ok: true, identity: { email: 'owner@example.com', sub: 'user-1' } });
    expect(urls).toEqual([`https://${TEST_TEAM}/cdn-cgi/access/certs`]);
  });

  it('accepts aud as a plain string and a team domain written with https://', async () => {
    const { v } = verifier(() => [keyA]);
    const token = await signJwt(keyA, validClaims(NOW, { aud: TEST_AUD }));
    expect((await v.verify(token, { teamDomain: `https://${TEST_TEAM}/`, aud: TEST_AUD })).ok).toBe(true);
  });

  it.each([
    ['wrong aud', { aud: ['other-aud'] }],
    ['missing aud', { aud: undefined }],
    ['wrong iss', { iss: 'https://evil.cloudflareaccess.com' }],
    ['iss without https', { iss: TEST_TEAM }],
    ['expired', { exp: Math.floor(NOW / 1000) - 120 }],
    ['missing exp', { exp: undefined }],
    ['not yet valid', { nbf: Math.floor(NOW / 1000) + 600 }],
  ])('rejects a token with %s', async (_name, overrides) => {
    const { v } = verifier(() => [keyA]);
    const result = await v.verify(await signJwt(keyA, validClaims(NOW, overrides)), config);
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('tolerates a small clock skew on exp and nbf', async () => {
    const { v } = verifier(() => [keyA]);
    const nowS = Math.floor(NOW / 1000);
    const token = await signJwt(keyA, validClaims(NOW, { exp: nowS - 30, nbf: nowS + 30 }));
    expect((await v.verify(token, config)).ok).toBe(true);
  });

  it('rejects a signature made with a key that is not in the JWKS (forged kid)', async () => {
    const { v } = verifier(() => [keyA]);
    const forged = await signJwt(keyB, validClaims(NOW), { kid: 'kid-a' });
    expect(await v.verify(forged, config)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('rejects alg none / HS256 and malformed tokens', async () => {
    const { v } = verifier(() => [keyA]);
    const valid = await signJwt(keyA, validClaims(NOW));
    const [, body, sig] = valid.split('.');
    const none = btoa(JSON.stringify({ alg: 'none', kid: 'kid-a' })).replace(/=+$/, '');
    const hs = btoa(JSON.stringify({ alg: 'HS256', kid: 'kid-a' })).replace(/=+$/, '');
    for (const token of [`${none}.${body}.`, `${hs}.${body}.${sig}`, 'abc', 'a.b.c', `${valid}x`, '']) {
      expect((await v.verify(token, config)).ok).toBe(false);
    }
  });

  it('refuses everything while the team domain or AUD is not configured (fail closed)', async () => {
    const { v, urls } = verifier(() => [keyA]);
    const token = await signJwt(keyA, validClaims(NOW));
    for (const bad of [
      { teamDomain: '', aud: TEST_AUD },
      { teamDomain: undefined, aud: TEST_AUD },
      { teamDomain: TEST_TEAM, aud: '' },
      { teamDomain: TEST_TEAM, aud: undefined },
      { teamDomain: 'evil.example.com', aud: TEST_AUD },
    ]) {
      expect(await v.verify(token, bad)).toEqual({ ok: false, reason: 'not_configured' });
    }
    expect(urls).toEqual([]);
  });

  it('reports a missing header as missing_token', async () => {
    const { v } = verifier(() => [keyA]);
    expect(await v.verify(null, config)).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('refetches the JWKS on an unknown kid (key rotation), rate limited', async () => {
    let keys = [keyA];
    let now = NOW;
    const { v, urls } = verifier(() => keys, () => now);
    expect((await v.verify(await signJwt(keyA, validClaims(now)), config)).ok).toBe(true);
    expect(urls).toHaveLength(1);

    // Unknown kid within the rate-limit window: no refetch, refused.
    keys = [keyA, keyB];
    now += 1_000;
    expect((await v.verify(await signJwt(keyB, validClaims(now)), config)).ok).toBe(false);
    expect(urls).toHaveLength(1);

    // After the window the rotation is picked up.
    now += JWKS_MIN_REFETCH_MS;
    expect((await v.verify(await signJwt(keyB, validClaims(now)), config)).ok).toBe(true);
    expect(urls).toHaveLength(2);
  });

  it('fails closed when the JWKS cannot be fetched', async () => {
    const v = new AccessVerifier({ fetchJwks: async () => new Response('down', { status: 500 }), now: () => NOW });
    expect(await v.verify(await signJwt(keyA, validClaims(NOW)), config)).toEqual({ ok: false, reason: 'jwks_unavailable' });
  });

  it('normalizes only <team>.cloudflareaccess.com domains', () => {
    expect(normalizeTeamDomain('Team.CloudflareAccess.com')).toBe('team.cloudflareaccess.com');
    expect(normalizeTeamDomain('https://team.cloudflareaccess.com/')).toBe('team.cloudflareaccess.com');
    expect(normalizeTeamDomain('team.cloudflareaccess.com.evil.com')).toBeNull();
    expect(normalizeTeamDomain('http://team.cloudflareaccess.com')).toBeNull();
    expect(normalizeTeamDomain('a.b.cloudflareaccess.com')).toBeNull();
    expect(normalizeTeamDomain('')).toBeNull();
  });
});
