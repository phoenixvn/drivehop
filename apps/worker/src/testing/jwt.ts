// Test helpers: a locally generated RSA key pair and an Access-style JWT signer (WebCrypto).

export const TEST_TEAM = 'multicloud-test.cloudflareaccess.com';
export const TEST_AUD = 'test-aud-tag-0123456789abcdef';

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encodeJson = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function generateTestKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid } };
}

export async function signJwt(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = encodeJson({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const body = encodeJson(claims);
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(signature)}`;
}

export function validClaims(nowMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return {
    aud: [TEST_AUD],
    iss: `https://${TEST_TEAM}`,
    email: 'owner@example.com',
    sub: 'user-1',
    iat: now - 10,
    nbf: now - 10,
    exp: now + 600,
    ...overrides,
  };
}

/** A JWKS endpoint stub that records every fetched URL. */
export function jwksStub(getKeys: () => TestKey[]): { fetch: (url: string) => Promise<Response>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string) => {
      urls.push(url);
      return Response.json({ keys: getKeys().map((key) => key.jwk), public_cert: { kid: 'stale', cert: '' } });
    },
  };
}
