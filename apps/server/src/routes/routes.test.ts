import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ProviderError } from '@multicloud/shared';
import type { CloudProvider, FileEntry } from '@multicloud/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../app.ts';
import type { BuildServerOptions, BuiltServer } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { AppConfig } from '../config.ts';
import { createMasterKeySource, createStaticKeySource } from '../crypto/keySource.ts';
import { createTokenCipher } from '../crypto/tokenCipher.ts';
import { openDatabase } from '../db/index.ts';
import type { ExchangeResult, GoogleAccessToken, GoogleOAuth } from '../google/oauth.ts';
import { OAUTH_STATE_COOKIE } from './auth.ts';

const REFRESH_TOKEN = '1//secret-refresh-token';
const CLIENT_SECRET = 'GOCSPX-secret-value';

function testConfig(configured: boolean): AppConfig {
  return loadConfig({
    envFile: null,
    env: {
      PORT: '8791',
      WEB_ORIGIN: 'http://localhost:5173',
      DATA_DIR: path.join(os.tmpdir(), 'multicloud-test-unused'),
      ...(configured ? { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: CLIENT_SECRET } : {}),
    },
  });
}

function fakeOAuth(result: () => ExchangeResult | Promise<ExchangeResult>) {
  const oauth = {
    generateAuthUrl: vi.fn((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    exchangeCode: vi.fn(async (_code: string) => result()),
    revokeToken: vi.fn(async (_token: string) => undefined),
    refreshAccessToken: vi.fn(async (_refreshToken: string): Promise<GoogleAccessToken> => {
      throw new Error('no network in tests');
    }),
  };
  return oauth as typeof oauth & GoogleOAuth;
}

const defaultExchange = (): ExchangeResult => ({
  refreshToken: REFRESH_TOKEN,
  profile: { email: 'An.Nguyen@Example.com', displayName: 'An Nguyễn', avatarUrl: 'https://x/a.png' },
});

function entry(id: string, name: string, parents: string[]): FileEntry {
  return {
    id,
    accountId: 'x',
    name,
    mimeType: 'application/vnd.google-apps.folder',
    isFolder: true,
    sizeBytes: null,
    modifiedTime: '2026-01-01T00:00:00Z',
    parents,
    isGoogleNative: false,
    capabilities: { canCopy: false, canTrash: true, canDownload: false },
  };
}

const servers: BuiltServer[] = [];

async function start(options: Partial<BuildServerOptions> & { configured?: boolean } = {}) {
  const { configured = true, ...rest } = options;
  const keySource = createStaticKeySource(randomBytes(32));
  const oauth = configured ? fakeOAuth(defaultExchange) : null;
  const server = await buildServer({
    config: testConfig(configured),
    db: openDatabase({ memory: true }),
    keySource,
    oauth,
    logger: false,
    ...rest,
  });
  servers.push(server);
  return { ...server, oauth: (rest.oauth ?? oauth) as ReturnType<typeof fakeOAuth>, cipher: createTokenCipher(keySource) };
}

/** Runs /start and returns the state plus the cookie header to send to /callback. */
async function beginLogin(server: BuiltServer) {
  const res = await server.app.inject({ method: 'GET', url: '/api/auth/google/start' });
  expect(res.statusCode).toBe(302);
  const state = new URL(res.headers.location as string).searchParams.get('state') as string;
  const setCookie = String(res.headers['set-cookie']);
  return { state, cookie: `${OAUTH_STATE_COOKIE}=${state}`, setCookie };
}

async function connect(server: BuiltServer): Promise<string> {
  const { state, cookie } = await beginLogin(server);
  const res = await server.app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?code=auth-code&state=${state}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(302);
  const id = new URL(res.headers.location as string).searchParams.get('connected');
  expect(id).toBeTruthy();
  return id as string;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.app.close();
});

describe('without Google credentials', () => {
  it('boots and reports the missing variables', async () => {
    const server = await start({ configured: false });
    const status = await server.app.inject({ method: 'GET', url: '/api/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      configured: false,
      missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      keyringAvailable: false,
    });

    const accounts = await server.app.inject({ method: 'GET', url: '/api/accounts' });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json()).toEqual({ accounts: [] });
  });

  it('answers 503 not_configured for the auth start, naming the variables', async () => {
    const server = await start({ configured: false });
    const res = await server.app.inject({ method: 'GET', url: '/api/auth/google/start' });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ code: string; message: string }>();
    expect(body.code).toBe('not_configured');
    expect(body.message).toContain('GOOGLE_CLIENT_ID');
    expect(body.message).toContain('GOOGLE_CLIENT_SECRET');
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
  });

  it('answers 503 for routes that need Google', async () => {
    const server = await start({ configured: false });
    const { account } = server.accounts.upsert({
      provider: 'google-drive',
      email: 'a@example.com',
      displayName: 'A',
      refreshTokenEnc: await server.cipher.encryptToken('token'),
    });
    for (const url of [`/api/accounts/${account.id}/quota`, `/api/accounts/${account.id}/files`]) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'not_configured' });
    }
  });

  it('reports keyringAvailable from the key source', async () => {
    const keyring = { getPassword: () => null, setPassword: () => undefined };
    const server = await start({ configured: true, keySource: createMasterKeySource({ keyring }) });
    const res = await server.app.inject({ method: 'GET', url: '/api/status' });
    expect(res.json()).toEqual({ configured: true, missing: [], keyringAvailable: true });
  });
});

describe('Google OAuth flow', () => {
  it('starts with a random state in an httpOnly SameSite=Lax cookie', async () => {
    const server = await start();
    const first = await beginLogin(server);
    const second = await beginLogin(server);
    expect(first.state).not.toBe(second.state);
    expect(first.setCookie).toContain(`${OAUTH_STATE_COOKIE}=${first.state}`);
    expect(first.setCookie).toMatch(/HttpOnly/i);
    expect(first.setCookie).toMatch(/SameSite=Lax/i);
    expect(server.oauth.generateAuthUrl).toHaveBeenCalledWith(first.state);
  });

  it('stores the account with an encrypted refresh token and redirects to WEB_ORIGIN', async () => {
    const server = await start();
    const { state, cookie } = await beginLogin(server);
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=auth-code&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe('http://localhost:5173');
    const id = location.searchParams.get('connected') as string;
    expect(server.oauth.exchangeCode).toHaveBeenCalledWith('auth-code');

    const list = await server.app.inject({ method: 'GET', url: '/api/accounts' });
    expect(list.json()).toEqual({
      accounts: [
        {
          id,
          provider: 'google-drive',
          email: 'an.nguyen@example.com',
          displayName: 'An Nguyễn',
          avatarUrl: 'https://x/a.png',
          status: 'connected',
        },
      ],
    });
    expect(list.body).not.toContain(REFRESH_TOKEN);
    expect(list.body.toLowerCase()).not.toContain('token');

    const row = server.db.prepare('SELECT refresh_token_enc FROM accounts WHERE id = ?').get(id) as {
      refresh_token_enc: Buffer;
    };
    expect(Buffer.isBuffer(row.refresh_token_enc)).toBe(true);
    expect(row.refresh_token_enc.includes(Buffer.from(REFRESH_TOKEN))).toBe(false);
    expect(await server.cipher.decryptToken(row.refresh_token_enc)).toBe(REFRESH_TOKEN);
    expect(server.getAccountEmail(id)).toBe('an.nguyen@example.com');
  });

  it('rejects a missing, mismatched, unknown or reused state with 400', async () => {
    const server = await start();
    const { state, cookie } = await beginLogin(server);
    const call = (url: string, headers: Record<string, string> = {}) =>
      server.app.inject({ method: 'GET', url, headers });

    // no state parameter
    expect((await call('/api/auth/google/callback?code=c', { cookie })).statusCode).toBe(400);
    // (the lookup above did not consume anything) no cookie
    const other = await beginLogin(server);
    expect((await call(`/api/auth/google/callback?code=c&state=${other.state}`)).statusCode).toBe(400);
    // cookie does not match the state parameter
    const third = await beginLogin(server);
    expect(
      (await call(`/api/auth/google/callback?code=c&state=${third.state}`, { cookie: `${OAUTH_STATE_COOKIE}=different` }))
        .statusCode,
    ).toBe(400);
    // state that was never issued, cookie matching it
    expect(
      (await call('/api/auth/google/callback?code=c&state=forged', { cookie: `${OAUTH_STATE_COOKIE}=forged` })).statusCode,
    ).toBe(400);

    // valid once ...
    const ok = await call(`/api/auth/google/callback?code=c&state=${state}`, { cookie });
    expect(ok.statusCode).toBe(302);
    // ... and rejected when replayed
    const replay = await call(`/api/auth/google/callback?code=c&state=${state}`, { cookie });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ code: 'bad_request' });
    expect(server.oauth.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired state', async () => {
    let time = Date.now();
    const server = await start({ now: () => time });
    const { state, cookie } = await beginLogin(server);
    time += 11 * 60 * 1000;
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=c&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(server.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('redirects with auth_error when the user denies access or the exchange fails', async () => {
    const failing = fakeOAuth(() => {
      throw Object.assign(new Error('invalid_grant'), { config: { data: `client_secret=${CLIENT_SECRET}` } });
    });
    const server = await start({ oauth: failing });

    const denied = await beginLogin(server);
    const deniedRes = await server.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?error=access_denied&state=${denied.state}`,
      headers: { cookie: denied.cookie },
    });
    expect(deniedRes.statusCode).toBe(302);
    expect(deniedRes.headers.location).toBe('http://localhost:5173/?auth_error=access_denied');

    const failed = await beginLogin(server);
    const failedRes = await server.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=bad&state=${failed.state}`,
      headers: { cookie: failed.cookie },
    });
    expect(failedRes.headers.location).toBe('http://localhost:5173/?auth_error=token_exchange_failed');
    expect(failedRes.body).not.toContain(CLIENT_SECRET);
    expect(server.accounts.list()).toEqual([]);
  });

  it('refuses to link an account when the Drive permission was not granted', async () => {
    const oauth = fakeOAuth(() => ({ ...defaultExchange(), driveScopeGranted: false }));
    const server = await start({ oauth });
    const login = await beginLogin(server);
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=c&state=${login.state}`,
      headers: { cookie: login.cookie },
    });
    expect(res.headers.location).toBe('http://localhost:5173/?auth_error=drive_scope_missing');
    expect(server.accounts.list()).toEqual([]);
  });

  it('keeps the stored refresh token when Google returns none, and errors when there is none at all', async () => {
    let result = defaultExchange();
    const oauth = fakeOAuth(() => result);
    const server = await start({ oauth });

    // unknown account + no refresh token -> error, nothing stored
    result = { ...defaultExchange(), refreshToken: null };
    const first = await beginLogin(server);
    const none = await server.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=c&state=${first.state}`,
      headers: { cookie: first.cookie },
    });
    expect(none.headers.location).toBe('http://localhost:5173/?auth_error=no_refresh_token');
    expect(server.accounts.list()).toEqual([]);

    // first real connect
    result = defaultExchange();
    const id = await connect(server);

    // reconnect without a refresh token: same id, token kept, profile updated
    result = { refreshToken: null, profile: { email: 'an.nguyen@example.com', displayName: 'Tên mới' } };
    expect(await connect(server)).toBe(id);
    expect(server.accounts.list()).toHaveLength(1);
    expect(server.accounts.get(id)?.displayName).toBe('Tên mới');
    expect(await server.cipher.decryptToken(server.accounts.getRefreshTokenEnc(id) as Buffer)).toBe(REFRESH_TOKEN);

    // reconnect with a new refresh token: replaced and status restored
    server.accounts.setStatus(id, 'needs_reconnect');
    result = { ...defaultExchange(), refreshToken: 'new-refresh-token' };
    expect(await connect(server)).toBe(id);
    expect(server.accounts.get(id)?.status).toBe('connected');
    expect(await server.cipher.decryptToken(server.accounts.getRefreshTokenEnc(id) as Buffer)).toBe('new-refresh-token');
  });

  it('refuses to connect accounts when no master key is available', async () => {
    const server = await start({ keySource: createMasterKeySource({ keyring: null }) });
    const res = await server.app.inject({ method: 'GET', url: '/api/auth/google/start' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ message: string }>().message).toContain('MULTICLOUD_MASTER_KEY');
    const status = await server.app.inject({ method: 'GET', url: '/api/status' });
    expect(status.json()).toMatchObject({ keyringAvailable: false });
  });
});

describe('account routes', () => {
  function providerStub(overrides: Partial<CloudProvider> = {}): CloudProvider {
    const tree: Record<string, FileEntry> = {
      root: entry('real-root-id', 'My Drive', []),
      'real-root-id': entry('real-root-id', 'My Drive', []),
      a: entry('a', 'Dự án', ['real-root-id']),
      b: entry('b', 'Ảnh', ['a']),
      shared: entry('shared', 'Shared folder', []),
      inside: entry('inside', 'Inside', ['shared']),
    };
    const stub = {
      id: 'google-drive',
      getQuota: vi.fn(async () => ({ usedBytes: 10, totalBytes: null })),
      listFolder: vi.fn(async () => ({ entries: [tree.a as FileEntry], nextPageToken: 'n' })),
      getFile: vi.fn(async (id: string) => {
        const found = tree[id];
        if (found === undefined) throw new ProviderError('nope', { kind: 'not_found', retryable: false, status: 404 });
        return found;
      }),
      ...overrides,
    };
    return stub as unknown as CloudProvider;
  }

  async function withProvider(provider: CloudProvider) {
    const resolveProvider = vi.fn(async () => provider);
    const server = await start({
      providers: { resolveProvider, getAccountEmail: () => 'stub@example.com' },
    });
    const id = await connect(server);
    return { server, id, resolveProvider };
  }

  it('returns quota, file listings and breadcrumbs in the contract shapes', async () => {
    const provider = providerStub();
    const { server, id } = await withProvider(provider);

    const quota = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/quota` });
    expect(quota.json()).toEqual({ quota: { usedBytes: 10, totalBytes: null } });

    const files = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/files` });
    expect(files.statusCode).toBe(200);
    expect(Object.keys(files.json()).sort()).toEqual(['entries', 'nextPageToken']);
    expect(provider.listFolder).toHaveBeenLastCalledWith('root', undefined);

    await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/files?folderId=a&pageToken=tok_1` });
    expect(provider.listFolder).toHaveBeenLastCalledWith('a', 'tok_1');

    const nested = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/folders/b/path` });
    expect(nested.json()).toEqual({
      breadcrumbs: [
        { id: 'root', name: 'My Drive' },
        { id: 'a', name: 'Dự án' },
        { id: 'b', name: 'Ảnh' },
      ],
    });
    const root = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/folders/root/path` });
    expect(root.json()).toEqual({ breadcrumbs: [{ id: 'root', name: 'My Drive' }] });
    const shared = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/folders/inside/path` });
    expect(shared.json()).toEqual({
      breadcrumbs: [
        { id: 'shared', name: 'Shared folder' },
        { id: 'inside', name: 'Inside' },
      ],
    });
  });

  it('caps the breadcrumb depth and survives parent cycles', async () => {
    const getFile = vi.fn(async (id: string) => {
      if (id === 'root') return entry('real-root-id', 'My Drive', []);
      const n = Number(id.slice(1));
      return entry(id, id, [`n${n + 1}`]);
    });
    const { server, id } = await withProvider(providerStub({ getFile } as Partial<CloudProvider>));
    const res = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/folders/n0/path` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ breadcrumbs: unknown[] }>().breadcrumbs).toHaveLength(50);
    expect(getFile.mock.calls.length).toBeLessThanOrEqual(52);
  });

  it('validates every parameter and answers 400', async () => {
    const provider = providerStub();
    const { server, id, resolveProvider } = await withProvider(provider);
    const bad = [
      `/api/accounts/${'x'.repeat(65)}/quota`,
      '/api/accounts/bad%20id/files',
      `/api/accounts/${id}/files?folderId=${encodeURIComponent("a' or '1'='1")}`,
      `/api/accounts/${id}/files?folderId=${'a'.repeat(129)}`,
      `/api/accounts/${id}/files?folderId=a&folderId=b`,
      `/api/accounts/${id}/files?pageToken=${'t'.repeat(2049)}`,
      `/api/accounts/${id}/folders/${encodeURIComponent('../x')}/path`,
      `/api/accounts/${id}/folders/${encodeURIComponent('a b')}/path`,
    ];
    resolveProvider.mockClear();
    for (const url of bad) {
      const res = await server.app.inject({ method: 'GET', url });
      expect([url, res.statusCode]).toEqual([url, 400]);
      expect(res.json()).toMatchObject({ code: 'bad_request' });
    }
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('answers 404 not_found for a well-formed id of an account that does not exist', async () => {
    const { server, resolveProvider } = await withProvider(providerStub());
    resolveProvider.mockClear();
    const requests: ['GET' | 'DELETE', string][] = [
      ['GET', '/api/accounts/does-not-exist/quota'],
      ['GET', '/api/accounts/does-not-exist/files'],
      ['GET', '/api/accounts/does-not-exist/folders/root/path'],
      ['DELETE', '/api/accounts/unknown-id'],
    ];
    for (const [method, url] of requests) {
      const res = await server.app.inject({ method, url });
      expect([url, res.statusCode]).toEqual([url, 404]);
      expect(res.json()).toMatchObject({ code: 'not_found' });
      expect(Object.keys(res.json()).sort()).toEqual(['code', 'message']);
    }
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('maps provider errors to API error codes without leaking details', async () => {
    const cases: [ProviderError, number, string][] = [
      [new ProviderError('Bearer ya29.secret', { kind: 'auth', retryable: false, status: 401 }), 401, 'needs_reconnect'],
      [new ProviderError('slow down', { kind: 'rate_limit', retryable: true, status: 429 }), 429, 'rate_limited'],
      [new ProviderError('gone', { kind: 'not_found', retryable: false, status: 404 }), 404, 'not_found'],
      [new ProviderError('no', { kind: 'forbidden', retryable: false, status: 403 }), 403, 'provider_error'],
      [new ProviderError('oops', { kind: 'server', retryable: true, status: 500 }), 502, 'provider_error'],
    ];
    for (const [error, statusCode, code] of cases) {
      const provider = providerStub({ getQuota: vi.fn(async () => Promise.reject(error)) } as Partial<CloudProvider>);
      const { server, id } = await withProvider(provider);
      const res = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/quota` });
      expect(res.statusCode).toBe(statusCode);
      const body = res.json<Record<string, string>>();
      expect(body.code).toBe(code);
      expect(Object.keys(body).sort()).toEqual(['code', 'message']);
      expect(res.body).not.toContain('ya29');
      expect(res.body).not.toContain('stack');
    }
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const provider = providerStub({
      getQuota: vi.fn(async () => Promise.reject(new Error(`boom ${REFRESH_TOKEN}`))),
    } as Partial<CloudProvider>);
    const { server, id } = await withProvider(provider);
    const res = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/quota` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'internal', message: expect.any(String) as string });
    expect(res.body).not.toContain(REFRESH_TOKEN);
  });

  it('removes the account locally, revokes the token best-effort and never touches Drive data', async () => {
    const trash = vi.fn();
    const provider = providerStub({ trash } as Partial<CloudProvider>);
    const { server, id, resolveProvider } = await withProvider(provider);
    server.oauth.revokeToken.mockRejectedValueOnce(new Error('network down'));
    resolveProvider.mockClear();

    const res = await server.app.inject({ method: 'DELETE', url: `/api/accounts/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(server.oauth.revokeToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(server.accounts.list()).toEqual([]);
    expect(() => server.getAccountEmail(id)).not.toThrow(); // stubbed override

    const again = await server.app.inject({ method: 'DELETE', url: `/api/accounts/${id}` });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('configuration', () => {
  it('resolves defaults relative to the repository root and treats empty values as missing', async () => {
    const { REPO_ROOT } = await import('../config.ts');
    const config = loadConfig({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '  ' }, envFile: null });
    expect(config.dataDir).toBe(path.join(REPO_ROOT, 'data'));
    expect(path.basename(REPO_ROOT)).toBe('MultiCloud');
    expect(config).toMatchObject({
      port: 8787,
      webOrigin: 'http://localhost:5173',
      googleClientId: null,
      googleClientSecret: null,
      masterKeyBase64: null,
      redirectUri: 'http://localhost:8787/api/auth/google/callback',
    });
    expect(() => loadConfig({ env: { PORT: 'abc' }, envFile: null })).toThrow(/PORT/);
  });
});

describe('server hardening', () => {
  it('limits CORS to WEB_ORIGIN', async () => {
    const server = await start();
    const allowed = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const other = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'http://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).not.toBe('http://evil.example');
    expect(other.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('rejects requests for foreign Host names and unknown routes with {code,message}', async () => {
    const server = await start();
    const foreign = await server.app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { host: 'evil.example:8787' },
    });
    expect(foreign.statusCode).toBe(403);

    const missing = await server.app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'not_found' });
  });

  it('refuses state-changing requests that a browser sends from another origin (CSRF)', async () => {
    const server = await start();
    const id = await connect(server);
    for (const origin of ['http://evil.example', 'null', 'http://localhost:5174', 'http://127.0.0.1:5173']) {
      for (const [method, url] of [
        ['POST', '/api/transfers/job-1/cancel'],
        ['POST', '/api/transfers/job-1/retry-failed'],
        ['POST', '/api/transfers'],
        ['DELETE', `/api/accounts/${id}`],
      ] as const) {
        const res = await server.app.inject({ method, url, headers: { origin } });
        expect(res.statusCode, `${method} ${url} from ${origin}`).toBe(403);
      }
    }
    expect(server.accounts.exists(id)).toBe(true);

    // The web UI's own origin and non-browser clients (no Origin header) still work.
    const fromUi = await server.app.inject({
      method: 'POST',
      url: '/api/transfers/job-1/cancel',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(fromUi.statusCode).toBe(404);
    const noOrigin = await server.app.inject({ method: 'POST', url: '/api/transfers/job-1/cancel' });
    expect(noOrigin.statusCode).toBe(404);
  });

  it('refuses requests a browser marks as cross-site, except the Google callback', async () => {
    const server = await start();
    const start1 = await server.app.inject({
      method: 'GET',
      url: '/api/auth/google/start',
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
    });
    expect(start1.statusCode).toBe(403);
    expect(start1.headers['set-cookie']).toBeUndefined();
    const sameOrigin = await server.app.inject({
      method: 'GET',
      url: '/api/auth/google/start',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(sameOrigin.statusCode).toBe(302);
    const callback = await server.app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=x&state=y',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(callback.statusCode).toBe(400); // rejected by the OAuth state check, not by the guard
    expect(callback.json()).toMatchObject({ code: 'bad_request' });
  });

  it('does not accept a JSON body sent as text/plain (a CORS-safelisted content type)', async () => {
    const server = await start();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/transfers',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({
        mode: 'copy',
        sourceAccountId: 'a',
        destAccountId: 'b',
        destFolderId: 'root',
        sourceFileIds: ['x'],
      }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('the default registry is used when no provider override is given', async () => {
    const server = await start();
    const id = await connect(server);
    expect(server.getAccountEmail(id)).toBe('an.nguyen@example.com');
    expect(() => server.getAccountEmail('missing')).toThrow();
    // refreshAccessToken of the fake throws: it must surface as a provider error, not a crash.
    const res = await server.app.inject({ method: 'GET', url: `/api/accounts/${id}/quota` });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'message']);
  });
});
