import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkerEnv } from './env.ts';
import { createWorkerHandler } from './index.ts';
import { TEST_AUD, TEST_TEAM, generateTestKey, jwksStub, signJwt, validClaims } from './testing/jwt.ts';
import type { TestKey } from './testing/jwt.ts';

// The Worker's front door: Access on every request (assets included), the dev bypass, CSRF.

let key: TestKey;
const assetRequests: string[] = [];
const fakeAssets = {
  fetch: async (input: RequestInfo | URL) => {
    assetRequests.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
    return new Response('<!doctype html><title>MultiCloud</title>', { headers: { 'Content-Type': 'text/html' } });
  },
} as unknown as Fetcher;

beforeAll(async () => {
  key = await generateTestKey('kid-1');
});

const baseEnv = env as unknown as WorkerEnv;
const accessEnv = (): WorkerEnv => ({ ...baseEnv, ASSETS: fakeAssets, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD });
const unconfiguredEnv = (): WorkerEnv => ({ ...baseEnv, ASSETS: fakeAssets, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' });

function handler() {
  const jwks = jwksStub(() => [key]);
  return { h: createWorkerHandler({ fetchJwks: jwks.fetch }), jwks };
}

async function call(h: ExportedHandler<WorkerEnv>, request: Request, workerEnv: WorkerEnv): Promise<Response> {
  const fetchHandler = h.fetch;
  if (fetchHandler === undefined) throw new Error('no fetch handler');
  return fetchHandler(request as Request<unknown, IncomingRequestCfProperties>, workerEnv, {} as ExecutionContext);
}

describe('security headers', () => {
  it('are on every response: assets, API, redirects and refusals', async () => {
    const { h } = handler();
    const token = await signJwt(key, validClaims(Date.now()));
    const headers = { 'Cf-Access-Jwt-Assertion': token };
    const responses = [
      await call(h, new Request('https://multicloud.example.com/', { headers }), accessEnv()),
      await call(h, new Request('https://multicloud.example.com/api/status', { headers }), accessEnv()),
      await call(h, new Request('https://multicloud.example.com/api/nope', { headers }), accessEnv()),
      await call(h, new Request('https://multicloud.example.com/'), accessEnv()),
      await call(h, new Request('https://multicloud.example.com/api/status'), unconfiguredEnv()),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 404, 403, 403]);
    for (const res of responses) {
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    }
    assetRequests.length = 0;
  });
});

describe('Access gate', () => {
  it('fails closed (plain 403, no API error code) for everything while Access is not configured', async () => {
    const { h, jwks } = handler();
    for (const path of ['/', '/index.html', '/assets/app.js', '/api/status', '/api/events', '/api/accounts']) {
      const res = await call(h, new Request(`https://multicloud.example.com${path}`), unconfiguredEnv());
      expect(res.status).toBe(403);
      expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/);
      const text = await res.text();
      expect(text).not.toMatch(/"code"/);
    }
    expect(jwks.urls).toEqual([]);
    expect(assetRequests).toEqual([]);
  });

  it('checks static asset requests too: no token, no page', async () => {
    const { h } = handler();
    const res = await call(h, new Request('https://multicloud.example.com/'), accessEnv());
    expect(res.status).toBe(403);
    expect(assetRequests).toEqual([]);
  });

  it('serves assets and forwards /api/* with a valid Access token', async () => {
    const { h } = handler();
    const token = await signJwt(key, validClaims(Date.now()));
    const page = await call(
      h,
      new Request('https://multicloud.example.com/some/spa/route', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      accessEnv(),
    );
    expect(page.status).toBe(200);
    expect(assetRequests).toContain('/some/spa/route');

    const status = await call(
      h,
      new Request('https://multicloud.example.com/api/status', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      accessEnv(),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ keyringAvailable: true });
  });

  it('rejects wrong aud / expired / foreign-key tokens on API and asset paths', async () => {
    const { h } = handler();
    const other = await generateTestKey('kid-1');
    const now = Date.now();
    const tokens = [
      await signJwt(key, validClaims(now, { aud: ['someone-else'] })),
      await signJwt(key, validClaims(now, { exp: Math.floor(now / 1000) - 3600 })),
      await signJwt(key, validClaims(now, { iss: 'https://other.cloudflareaccess.com' })),
      await signJwt(other, validClaims(now)),
      await signJwt(key, validClaims(now), { kid: 'unknown-kid' }),
    ];
    for (const token of tokens) {
      for (const path of ['/', '/api/accounts']) {
        const res = await call(
          h,
          new Request(`https://multicloud.example.com${path}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }),
          accessEnv(),
        );
        expect(res.status).toBe(403);
      }
    }
  });

  it('ignores the CF_Authorization cookie: only the header is accepted', async () => {
    const { h } = handler();
    const token = await signJwt(key, validClaims(Date.now()));
    const res = await call(h, new Request('https://multicloud.example.com/', { headers: { Cookie: `CF_Authorization=${token}` } }), accessEnv());
    expect(res.status).toBe(403);
  });
});

describe('dev bypass', () => {
  const bypassEnv = (extra: Partial<WorkerEnv> = {}): WorkerEnv => ({ ...unconfiguredEnv(), DEV_AUTH_BYPASS: 'true', ...extra });

  it('works only for 127.0.0.1 / localhost with DEV_AUTH_BYPASS=true and Access unconfigured', async () => {
    const { h } = handler();
    for (const origin of ['http://127.0.0.1:8799', 'http://localhost:8799']) {
      const res = await call(h, new Request(`${origin}/api/status`), bypassEnv());
      expect(res.status).toBe(200);
    }
  });

  it('is refused on a non-local host even with the variable set', async () => {
    const { h } = handler();
    for (const url of [
      'https://multicloud.example.com/api/status',
      'https://multicloud.example.com/',
      'http://127.0.0.1.nip.io:8799/api/status',
      'http://localhost.example.com/api/status',
      'http://[::1]:8799/api/status',
    ]) {
      const res = await call(h, new Request(url, { headers: { Host: '127.0.0.1' } }), bypassEnv());
      expect(res.status).toBe(403);
    }
  });

  it('cannot be enabled from the request (header, query string, cookie)', async () => {
    const { h } = handler();
    const tries = [
      new Request('http://127.0.0.1:8799/api/status?DEV_AUTH_BYPASS=true'),
      new Request('http://127.0.0.1:8799/api/status', { headers: { DEV_AUTH_BYPASS: 'true', 'X-Dev-Auth-Bypass': 'true' } }),
      new Request('http://127.0.0.1:8799/api/status', { headers: { Cookie: 'DEV_AUTH_BYPASS=true' } }),
    ];
    for (const request of tries) {
      const res = await call(h, request, unconfiguredEnv());
      expect(res.status).toBe(403);
    }
  });

  it('requires exactly "true" and is refused once Access is configured', async () => {
    const { h } = handler();
    for (const value of ['1', 'TRUE', 'yes', ' true']) {
      expect((await call(h, new Request('http://127.0.0.1:8799/api/status'), bypassEnv({ DEV_AUTH_BYPASS: value }))).status).toBe(403);
    }
    const configured = bypassEnv({ ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD });
    expect((await call(h, new Request('http://127.0.0.1:8799/api/status'), configured)).status).toBe(403);
  });
});

describe('CSRF', () => {
  const local = (): WorkerEnv => ({ ...unconfiguredEnv(), DEV_AUTH_BYPASS: 'true' });

  it('refuses a state-changing request from a foreign Origin', async () => {
    const { h } = handler();
    const res = await call(
      h,
      new Request('http://127.0.0.1:8799/api/transfers', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }),
      local(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'bad_request' });
  });

  it('refuses cross-site /api requests except the Google callback, but not page loads', async () => {
    const { h } = handler();
    const cross = { 'Sec-Fetch-Site': 'cross-site' };
    expect((await call(h, new Request('http://127.0.0.1:8799/api/accounts', { headers: cross }), local())).status).toBe(403);
    // The callback passes the CSRF layer (then fails on the missing OAuth state: 400, not 403).
    const callback = await call(h, new Request('http://127.0.0.1:8799/api/auth/google/callback?state=x', { headers: cross }), local());
    expect(callback.status).not.toBe(403);
    const page = await call(h, new Request('http://127.0.0.1:8799/', { headers: { ...cross, 'Sec-Fetch-Mode': 'navigate' } }), {
      ...local(),
      ASSETS: fakeAssets,
    });
    expect(page.status).toBe(200);
  });

  it('accepts a same-origin POST', async () => {
    const { h } = handler();
    const res = await call(
      h,
      new Request('http://127.0.0.1:8799/api/transfers/abc/retry-failed', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8799' } }),
      local(),
    );
    expect(res.status).toBe(404); // reached the object: unknown job
  });
});
