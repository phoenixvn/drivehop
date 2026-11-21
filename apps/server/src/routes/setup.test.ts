import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../app.ts';
import type { BuiltServer } from '../app.ts';
import { SETTINGS_FILE_NAME, loadConfig } from '../config.ts';
import { createStaticKeySource } from '../crypto/keySource.ts';
import { openDatabase } from '../db/index.ts';
import { resolveStaticPath } from '../static.ts';

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test_Secret-123';
const ORIGIN = 'http://localhost:8792';

const dirs: string[] = [];
const servers: BuiltServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'drivehop-setup-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.app.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function start(options: { dataDir: string; webDist?: string; onSetupSaved?: () => void }) {
  const config = loadConfig({
    // envFile pointing at a missing file: hermetic, but the settings file is still read.
    envFile: path.join(options.dataDir, 'no-such.env'),
    env: {
      PORT: '8792',
      WEB_ORIGIN: ORIGIN,
      DATA_DIR: options.dataDir,
      ...(options.webDist === undefined ? {} : { WEB_DIST: options.webDist }),
    },
  });
  const server = await buildServer({
    config,
    db: openDatabase({ memory: true }),
    keySource: createStaticKeySource(randomBytes(32)),
    logger: false,
    ...(options.onSetupSaved === undefined ? {} : { onSetupSaved: options.onSetupSaved }),
  });
  servers.push(server);
  return server;
}

const postSetup = (server: BuiltServer, payload: object, origin = ORIGIN) =>
  server.app.inject({ method: 'POST', url: '/api/setup', headers: { origin }, payload });

describe('in-app setup (POST /api/setup)', () => {
  it('is not offered unless the host enables it', async () => {
    const server = await start({ dataDir: tempDir() });
    const status = (await server.app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(status.setup).toBeUndefined();
    const res = await postSetup(server, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(res.statusCode).toBe(404);
  });

  it('reports the redirect URI and saves the client, then asks for a restart', async () => {
    const dataDir = tempDir();
    const onSetupSaved = vi.fn();
    const server = await start({ dataDir, onSetupSaved });

    const status = (await server.app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(status.configured).toBe(false);
    expect(status.setup).toEqual({
      allowed: true,
      redirectUri: 'http://localhost:8792/api/auth/google/callback',
      webOrigin: ORIGIN,
    });

    const res = await postSetup(server, { clientId: ` ${CLIENT_ID} `, clientSecret: CLIENT_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.body).not.toContain(CLIENT_SECRET);

    const saved = readFileSync(path.join(dataDir, SETTINGS_FILE_NAME), 'utf8');
    expect(saved).toContain(`GOOGLE_CLIENT_ID=${CLIENT_ID}\n`);
    expect(saved).toContain(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\n`);
    await vi.waitFor(() => expect(onSetupSaved).toHaveBeenCalledTimes(1));

    // A fresh config (what the restart builds) picks the client up.
    const reloaded = loadConfig({
      envFile: path.join(dataDir, 'no-such.env'),
      env: { DATA_DIR: dataDir, PORT: '8792' },
    });
    expect(reloaded.googleClientId).toBe(CLIENT_ID);
    expect(reloaded.googleClientSecret).toBe(CLIENT_SECRET);
  });

  it('rejects malformed values without echoing them', async () => {
    const dataDir = tempDir();
    const server = await start({ dataDir, onSetupSaved: vi.fn() });
    for (const payload of [
      { clientId: 'not-a-client-id', clientSecret: CLIENT_SECRET },
      { clientId: CLIENT_ID, clientSecret: 'GOCSPX-has space' },
      { clientId: CLIENT_ID, clientSecret: 'GOCSPX-x\nEVIL=1' },
      { clientId: `${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=x`, clientSecret: CLIENT_SECRET },
      { clientId: CLIENT_ID },
    ]) {
      const res = await postSetup(server, payload);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('GOCSPX-');
    }
    expect(existsSync(path.join(dataDir, SETTINGS_FILE_NAME))).toBe(false);
  });

  it('is refused once an account is linked (tokens belong to the client)', async () => {
    const dataDir = tempDir();
    const server = await start({ dataDir, onSetupSaved: vi.fn() });
    server.accounts.upsert({
      provider: 'google-drive',
      email: 'a@example.com',
      displayName: 'A',
      refreshTokenEnc: null,
    });
    const status = (await server.app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(status.setup.allowed).toBe(false);
    const res = await postSetup(server, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(res.statusCode).toBe(409);
    expect(existsSync(path.join(dataDir, SETTINGS_FILE_NAME))).toBe(false);
  });

  it('refuses a cross-origin POST (CSRF)', async () => {
    const dataDir = tempDir();
    const server = await start({ dataDir, onSetupSaved: vi.fn() });
    const res = await postSetup(server, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, 'https://evil.example');
    expect(res.statusCode).toBe(403);
    expect(existsSync(path.join(dataDir, SETTINGS_FILE_NAME))).toBe(false);
  });
});

describe('settings file precedence', () => {
  it('environment variables win over the settings file', () => {
    const dataDir = tempDir();
    writeFileSync(
      path.join(dataDir, SETTINGS_FILE_NAME),
      `GOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=${CLIENT_SECRET}\n`,
    );
    const config = loadConfig({
      envFile: path.join(dataDir, 'no-such.env'),
      env: { DATA_DIR: dataDir, GOOGLE_CLIENT_ID: 'env-id.apps.googleusercontent.com' },
    });
    expect(config.googleClientId).toBe('env-id.apps.googleusercontent.com');
    expect(config.googleClientSecret).toBe(CLIENT_SECRET);
  });

  it('is ignored by hermetic callers (envFile: null)', () => {
    const dataDir = tempDir();
    writeFileSync(path.join(dataDir, SETTINGS_FILE_NAME), `GOOGLE_CLIENT_ID=${CLIENT_ID}\n`);
    const config = loadConfig({ envFile: null, env: { DATA_DIR: dataDir } });
    expect(config.googleClientId).toBeNull();
  });
});

describe('serving the built web UI (WEB_DIST)', () => {
  function makeDist(): string {
    const dist = tempDir();
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>DriveHop</title>');
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
    return dist;
  }

  it('serves files, falls back to index.html, and keeps /api 404s as JSON', async () => {
    const server = await start({ dataDir: tempDir(), webDist: makeDist() });

    const root = await server.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.headers['content-security-policy']).toContain("default-src 'self'");
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.body).toContain('<title>DriveHop</title>');

    const asset = await server.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');

    const spa = await server.app.inject({ method: 'GET', url: '/files/some/deep/link?x=1' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<title>DriveHop</title>');

    const api = await server.app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().code).toBe('not_found');

    const post = await server.app.inject({ method: 'POST', url: '/somewhere', headers: { origin: ORIGIN } });
    expect(post.statusCode).toBe(404);
  });

  it('never resolves a path outside the build folder', () => {
    const dist = makeDist();
    const outside = `${path.basename(dist)}-secret.txt`;
    const secret = path.join(path.dirname(dist), outside);
    writeFileSync(secret, 'secret');
    try {
      expect(resolveStaticPath(dist, `/../${outside}`)).toBeNull();
      expect(resolveStaticPath(dist, `/%2e%2e/${outside}`)).toBeNull();
      expect(resolveStaticPath(dist, `/..%5c${outside}`)).toBeNull();
      expect(resolveStaticPath(dist, '/%00')).toBeNull();
      expect(resolveStaticPath(dist, '/%E0%A4%A')).toBeNull();
      expect(resolveStaticPath(dist, '/assets')).toBeNull();
      expect(resolveStaticPath(dist, '/assets/app-abc123.js')).toBe(path.join(dist, 'assets', 'app-abc123.js'));
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it('does not serve the UI when WEB_DIST is not set', async () => {
    const server = await start({ dataDir: tempDir() });
    const res = await server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });
});
