// Cloudflare Access JWT validation with WebCrypto only (no dependency).
//
// Verified against https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
// - the token arrives in the `Cf-Access-Jwt-Assertion` request header (preferred over the cookie);
// - keys: https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, RS256, select by `kid` from
//   `keys` (never the single `public_cert`, which may be stale);
// - `aud` must contain the application's AUD tag, `iss` must be https://<team>.cloudflareaccess.com;
// - keys rotate every 6 weeks, the previous key stays valid 7 days: fetch, never hard-code.
// exp / nbf are standard JWT claims (RFC 7519) and are enforced here with a small leeway.

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
/** Accepted clock skew for exp / nbf, in seconds. */
export const ACCESS_CLOCK_LEEWAY_S = 60;
/** How long fetched keys are trusted before a refetch. */
export const JWKS_CACHE_TTL_MS = 10 * 60_000;
/** Minimum gap between two JWKS fetches triggered by an unknown `kid` (rate limit). */
export const JWKS_MIN_REFETCH_MS = 30_000;
/** Tokens longer than this are refused without parsing. */
const MAX_TOKEN_LENGTH = 16_384;
const TEAM_DOMAIN_SUFFIX = '.cloudflareaccess.com';

export type JwksFetcher = (url: string) => Promise<Response>;

export interface AccessConfig {
  /** `<team>.cloudflareaccess.com`, with or without `https://`. */
  teamDomain: string | undefined;
  /** Application Audience (AUD) tag. */
  aud: string | undefined;
}

export interface AccessIdentity {
  email?: string;
  sub?: string;
}

export type AccessResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; reason: 'not_configured' | 'missing_token' | 'invalid_token' | 'jwks_unavailable' };

/**
 * Normalises ACCESS_TEAM_DOMAIN to a bare hostname `<team>.cloudflareaccess.com`.
 * Returns null for anything else (fail closed on a misconfiguration).
 */
export function normalizeTeamDomain(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (value.startsWith('https://')) value = value.slice('https://'.length);
  if (value.endsWith('/')) value = value.slice(0, -1);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(value)) return null;
  if (!value.endsWith(TEAM_DOMAIN_SUFFIX)) return null;
  return value;
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('bad base64url');
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/**
 * Validates Access tokens for one Worker isolate. Keys are cached per team domain; an unknown
 * `kid` triggers a refetch at most every JWKS_MIN_REFETCH_MS.
 */
export class AccessVerifier {
  private readonly cache = new Map<string, CachedKeys>();
  private readonly inflight = new Map<string, Promise<CachedKeys | null>>();
  private readonly lastFetch = new Map<string, number>();
  private readonly fetchJwks: JwksFetcher;
  private readonly now: () => number;

  constructor(options: { fetchJwks?: JwksFetcher; now?: () => number } = {}) {
    this.fetchJwks = options.fetchJwks ?? ((url) => fetch(url, { headers: { accept: 'application/json' } }));
    this.now = options.now ?? Date.now;
  }

  async verify(token: string | null | undefined, config: AccessConfig): Promise<AccessResult> {
    const team = normalizeTeamDomain(config.teamDomain);
    const aud = typeof config.aud === 'string' ? config.aud.trim() : '';
    if (team === null || aud === '') return { ok: false, reason: 'not_configured' };
    if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing_token' };
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'invalid_token' };

    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'invalid_token' };
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    let header: unknown;
    let payload: unknown;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = decodeJson(headerPart);
      payload = decodeJson(payloadPart);
      signature = base64UrlToBytes(signaturePart);
    } catch {
      return { ok: false, reason: 'invalid_token' };
    }
    if (!isRecord(header) || !isRecord(payload)) return { ok: false, reason: 'invalid_token' };
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '') {
      return { ok: false, reason: 'invalid_token' };
    }

    const key = await this.keyFor(team, header.kid);
    if (key === 'unavailable') return { ok: false, reason: 'jwks_unavailable' };
    if (key === null) return { ok: false, reason: 'invalid_token' };

    let valid = false;
    try {
      valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        signature,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      );
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: 'invalid_token' };

    // Claims (only checked after the signature, so nothing unauthenticated is interpreted).
    if (payload.iss !== `https://${team}`) return { ok: false, reason: 'invalid_token' };
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.some((value) => value === aud)) return { ok: false, reason: 'invalid_token' };
    const nowS = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + ACCESS_CLOCK_LEEWAY_S <= nowS) {
      return { ok: false, reason: 'invalid_token' };
    }
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - ACCESS_CLOCK_LEEWAY_S > nowS)) {
      return { ok: false, reason: 'invalid_token' };
    }

    const identity: AccessIdentity = {};
    if (typeof payload.email === 'string') identity.email = payload.email;
    if (typeof payload.sub === 'string') identity.sub = payload.sub;
    return { ok: true, identity };
  }

  /** CryptoKey for `kid`, null when the key set has no such key, 'unavailable' when it cannot be loaded. */
  private async keyFor(team: string, kid: string): Promise<CryptoKey | null | 'unavailable'> {
    const now = this.now();
    let entry = this.cache.get(team);
    const stale = entry === undefined || now - entry.fetchedAt > JWKS_CACHE_TTL_MS;
    const unknownKid = entry !== undefined && !entry.keys.has(kid);
    const mayRefetch = now - (this.lastFetch.get(team) ?? Number.NEGATIVE_INFINITY) >= JWKS_MIN_REFETCH_MS;
    if (stale || (unknownKid && mayRefetch)) {
      const fresh = await this.load(team);
      if (fresh !== null) entry = fresh;
      else if (entry === undefined || stale) return 'unavailable';
    }
    return entry?.keys.get(kid) ?? null;
  }

  private load(team: string): Promise<CachedKeys | null> {
    const pending = this.inflight.get(team);
    if (pending !== undefined) return pending;
    const run = (async (): Promise<CachedKeys | null> => {
      this.lastFetch.set(team, this.now());
      try {
        const response = await this.fetchJwks(`https://${team}/cdn-cgi/access/certs`);
        if (!response.ok) return null;
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.keys)) return null;
        const keys = new Map<string, CryptoKey>();
        for (const jwk of body.keys) {
          if (!isRecord(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
          if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
          if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
          try {
            const key = await crypto.subtle.importKey(
              'jwk',
              { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
              { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
              false,
              ['verify'],
            );
            keys.set(jwk.kid, key);
          } catch {
            // Skip a malformed key; the others may still be usable.
          }
        }
        const entry: CachedKeys = { keys, fetchedAt: this.now() };
        this.cache.set(team, entry);
        return entry;
      } catch {
        return null;
      } finally {
        this.inflight.delete(team);
      }
    })();
    this.inflight.set(team, run);
    return run;
  }
}
