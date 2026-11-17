import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineTransferJob } from '@multicloud/core';
import type { Account, CreateTransferRequest } from '@multicloud/shared';
import { CORE_OBJECT_NAME } from './env.ts';
import type { WorkerEnv } from './env.ts';
import { setHostDepsForTesting } from './hostDeps.ts';
import type { HostDeps } from './hostDeps.ts';
import { createWorkerHandler } from './index.ts';
import type { MultiCloudCore } from './index.ts';
import { SSE_IDLE_EVENT } from './sse.ts';
import { REFRESH_TOKEN_PREFIX, TEST_MASTER_KEY, createTestHarness, exchangeResult } from './testing/fakes.ts';
import type { TestHarness } from './testing/fakes.ts';

// The Durable Object host end to end: requests go through the real Worker entry (dev bypass on
// 127.0.0.1), the object runs on the real Durable Object SQLite, Google is replaced by fakes.

const ORIGIN = 'http://127.0.0.1:8799';
const workerEnv = (): WorkerEnv => ({ ...(env as unknown as WorkerEnv), ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_AUTH_BYPASS: 'true' });
const handler = createWorkerHandler();

let h: TestHarness;
const logLines: string[] = [];

function setup(options: Parameters<typeof createTestHarness>[0] = {}, extra: Partial<HostDeps> = {}): TestHarness {
  h = createTestHarness(options);
  setHostDepsForTesting({ ...h.deps, ...extra });
  return h;
}

beforeEach(() => {
  logLines.length = 0;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
  }
});

afterEach(async () => {
  // No log line may ever carry a token.
  for (const line of logLines) {
    expect(line).not.toContain(REFRESH_TOKEN_PREFIX);
    expect(line).not.toContain('access-for-');
    expect(line).not.toContain('test-client-secret');
  }
  vi.restoreAllMocks();
  // Fresh object for the next test: wipe its storage (SQL tables included) and drop the instance.
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
  await abortAllDurableObjects();
  setHostDepsForTesting(null);
});

const stub = (): DurableObjectStub<MultiCloudCore> => env.CORE.get(env.CORE.idFromName(CORE_OBJECT_NAME));

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const fetchHandler = handler.fetch;
  if (fetchHandler === undefined) throw new Error('no fetch handler');
  const headers = new Headers(init.headers);
  if (init.method !== undefined && init.method !== 'GET') headers.set('Origin', ORIGIN);
  const request = new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' });
  return fetchHandler(request as Request<unknown, IncomingRequestCfProperties>, workerEnv(), {} as ExecutionContext);
}

async function jsonOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  // Nothing the API returns may contain a token.
  expect(text).not.toContain(REFRESH_TOKEN_PREFIX);
  expect(text).not.toContain('access-for-');
  return JSON.parse(text) as T;
}

async function getAlarm(): Promise<number | null> {
  return runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());
}

async function startFlow(): Promise<{ state: string; cookie: string; res: Response }> {
  const res = await api('/api/auth/google/start');
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('Location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  const setCookie = res.headers.get('Set-Cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { state, cookie, res };
}

/** Connects an account through the real OAuth routes and registers it in the FakeDrive. */
async function connect(email: string): Promise<string> {
  const { state, cookie } = await startFlow();
  h.oauth.codes.set(`code-${email}`, exchangeResult(email));
  const res = await api(`/api/auth/google/callback?code=code-${email}&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(302);
  const id = new URL(res.headers.get('Location') ?? '').searchParams.get('connected');
  if (id === null) throw new Error(`connect failed: ${res.headers.get('Location')}`);
  // A (re)connect schedules one background run (it sweeps permissions left while the token was
  // invalid). Clear it so each test starts from "no alarm pending".
  expect(await getAlarm()).not.toBeNull();
  await runInDurableObject(stub(), (_instance, state) => state.storage.deleteAlarm());
  h.drive.addAccount(id, email);
  return id;
}

async function createJob(body: CreateTransferRequest): Promise<EngineTransferJob> {
  const res = await api('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await jsonOf<{ job: EngineTransferJob }>(res)).job;
}

async function getJob(id: string): Promise<EngineTransferJob> {
  return (await jsonOf<{ job: EngineTransferJob }>(await api(`/api/transfers/${id}`))).job;
}

const TRANSFER_OPS = ['copyWithin', 'shareWithAccount', 'resumableUploadFromStream', 'downloadStream', 'trash', 'createFolder'] as const;

// ---------------------------------------------------------------------------------------------

describe('status and configuration', () => {
  it('reports configured with all secrets present (keyringAvailable is always true)', async () => {
    setup();
    expect(await jsonOf(await api('/api/status'))).toEqual({ configured: true, missing: [], keyringAvailable: true });
  });

  it('reports missing secrets and answers 503 not_configured where Google is needed', async () => {
    setup({}, { envOverride: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: ' ', MULTICLOUD_MASTER_KEY: 'c2hvcnQ=' } });
    expect(await jsonOf(await api('/api/status'))).toEqual({
      configured: false,
      missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MULTICLOUD_MASTER_KEY'],
      keyringAvailable: true,
    });
    const start = await api('/api/auth/google/start');
    expect(start.status).toBe(503);
    expect(await jsonOf(start)).toMatchObject({ code: 'not_configured' });
    const create = await api('/api/transfers', { method: 'POST', body: '{}' });
    expect(create.status).toBe(503);
  });

  it('refuses to start OAuth when the master key is not 32 bytes', async () => {
    setup({}, { envOverride: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', MULTICLOUD_MASTER_KEY: btoa('x'.repeat(31)) } });
    const res = await api('/api/auth/google/start');
    expect(res.status).toBe(503);
    expect((await jsonOf<{ message: string }>(res)).message).toContain('MULTICLOUD_MASTER_KEY');
  });
});

describe('OAuth', () => {
  it('start: single-use state, bound cookie with the required attributes, redirect URI from the host', async () => {
    setup();
    const { res, state } = await startFlow();
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(/^mc_oauth=[A-Za-z0-9_-]{20,};/);
    for (const attr of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api/auth/google', 'Max-Age=600']) expect(setCookie).toContain(attr);
    expect(state.length).toBeGreaterThan(20);
    expect(setCookie).not.toContain(state);
    expect(h.oauth.created.at(-1)?.redirectUri).toBe(`${ORIGIN}/api/auth/google/callback`);
  });

  it('start over https uses a __Secure- cookie (not __Host-, whose rules require Path=/)', async () => {
    setup();
    const res = await stub().fetch('https://multicloud.example.com/api/auth/google/start', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toMatch(/^__Secure-mc_oauth=/);
    expect(h.oauth.created.at(-1)?.redirectUri).toBe('https://multicloud.example.com/api/auth/google/callback');
  });

  it('callback: stores the account with an encrypted token, clears the cookie, redirects to the UI', async () => {
    setup();
    const { state, cookie } = await startFlow();
    h.oauth.codes.set('good-code', exchangeResult('alice@example.com'));
    const res = await api(`/api/auth/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location') ?? '');
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/');
    const id = location.searchParams.get('connected');
    expect(id).toBeTruthy();
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');

    const { accounts } = await jsonOf<{ accounts: Account[] }>(await api('/api/accounts'));
    expect(accounts).toEqual([
      {
        id,
        provider: 'google-drive',
        email: 'alice@example.com',
        displayName: 'alice',
        avatarUrl: 'https://lh3.googleusercontent.test/a.png',
        status: 'connected',
      },
    ]);
    const stored = await runInDurableObject(stub(), (_i, s) => {
      const row = s.storage.sql.exec('SELECT refresh_token_enc FROM accounts').toArray()[0];
      return new Uint8Array(row?.refresh_token_enc as ArrayBuffer);
    });
    expect(new TextDecoder().decode(stored)).not.toContain(REFRESH_TOKEN_PREFIX);
    expect(stored.length).toBeGreaterThan(4);

    // Replaying the same state is refused (single use).
    const replay = await api(`/api/auth/google/callback?code=good-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } });
    expect(replay.status).toBe(400);
  });

  it('callback: refuses a missing or mismatched cookie, an unknown state and an expired state', async () => {
    let now = Date.now();
    setup({}, { now: () => now });
    const first = await startFlow();
    expect((await api(`/api/auth/google/callback?code=c&state=${first.state}`)).status).toBe(400);
    // The failed attempt consumed the state: even the right cookie no longer works.
    expect((await api(`/api/auth/google/callback?code=c&state=${first.state}`, { headers: { Cookie: first.cookie } })).status).toBe(400);

    const second = await startFlow();
    expect((await api(`/api/auth/google/callback?code=c&state=${second.state}`, { headers: { Cookie: 'mc_oauth=forged' } })).status).toBe(400);
    expect((await api('/api/auth/google/callback?code=c&state=unknown', { headers: { Cookie: second.cookie } })).status).toBe(400);

    const third = await startFlow();
    now += 10 * 60_000 + 1;
    expect((await api(`/api/auth/google/callback?code=c&state=${third.state}`, { headers: { Cookie: third.cookie } })).status).toBe(400);
    expect(h.oauth.created.filter((o) => o.redirectUri.endsWith('/callback'))).toHaveLength(3); // start only
  });

  it.each([
    ['drive scope missing', { driveScopeGranted: false }, 'auth_error=drive_scope_missing'],
    ['no refresh token on first consent', { refreshToken: null }, 'auth_error=no_refresh_token'],
  ])('callback: %s', async (_name, overrides, expected) => {
    setup();
    const { state, cookie } = await startFlow();
    h.oauth.codes.set('c', exchangeResult('bob@example.com', overrides));
    const res = await api(`/api/auth/google/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
    expect(res.headers.get('Location')).toContain(expected);
    expect(await jsonOf<{ accounts: Account[] }>(await api('/api/accounts'))).toEqual({ accounts: [] });
  });

  it('callback: Google error and failed exchange map to auth_error codes', async () => {
    setup();
    let flow = await startFlow();
    let res = await api(`/api/auth/google/callback?error=access_denied&state=${flow.state}`, { headers: { Cookie: flow.cookie } });
    expect(res.headers.get('Location')).toContain('auth_error=access_denied');
    flow = await startFlow();
    res = await api(`/api/auth/google/callback?code=unknown&state=${flow.state}`, { headers: { Cookie: flow.cookie } });
    expect(res.headers.get('Location')).toContain('auth_error=token_exchange_failed');
  });

  it('callback: a non-https avatar is dropped', async () => {
    setup();
    const { state, cookie } = await startFlow();
    const result = exchangeResult('carol@example.com');
    result.profile.avatarUrl = 'javascript:alert(1)';
    h.oauth.codes.set('c', result);
    await api(`/api/auth/google/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
    const { accounts } = await jsonOf<{ accounts: Account[] }>(await api('/api/accounts'));
    expect(accounts[0]?.avatarUrl).toBeUndefined();
  });
});

describe('accounts routes (parity with the Node host)', () => {
  it('quota, files, folder path, validation and 404s', async () => {
    setup();
    const id = await connect('dave@example.com');
    const provider = h.drive.provider(id);
    const folder = provider.addFolder('root', 'Docs');
    const sub = provider.addFolder(folder, 'Sub');
    provider.addFile(sub, 'a.txt', 'hello');

    const quota = await jsonOf<{ quota: unknown }>(await api(`/api/accounts/${id}/quota`));
    expect(quota.quota).toMatchObject({ usedBytes: expect.any(Number) });

    const listing = await jsonOf<{ entries: Array<{ name: string }> }>(await api(`/api/accounts/${id}/files?folderId=${sub}`));
    expect(listing.entries.map((e) => e.name)).toEqual(['a.txt']);

    const path = await jsonOf<{ breadcrumbs: Array<{ id: string; name: string }> }>(await api(`/api/accounts/${id}/folders/${sub}/path`));
    expect(path.breadcrumbs).toEqual([
      { id: 'root', name: 'My Drive' },
      { id: folder, name: 'Docs' },
      { id: sub, name: 'Sub' },
    ]);

    expect((await api('/api/accounts/bad%20id/quota')).status).toBe(400);
    expect((await api('/api/accounts/unknown-id/quota')).status).toBe(404);
    expect((await api(`/api/accounts/${id}/files?folderId=../x`)).status).toBe(400);
    const missing = await api('/api/nope');
    expect(missing.status).toBe(404);
    expect(await jsonOf(missing)).toEqual({ code: 'not_found', message: expect.any(String) });
    expect((await api('/api/accounts', { method: 'POST' })).status).toBe(404);
  });

  it('a provider auth error maps to 401 needs_reconnect', async () => {
    setup();
    const id = await connect('erin@example.com');
    const { fakeError } = await import('@multicloud/core/testing');
    h.drive.provider(id).failNext('getQuota', fakeError('auth', 401));
    const res = await api(`/api/accounts/${id}/quota`);
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toMatchObject({ code: 'needs_reconnect' });
  });

  it('DELETE disconnects locally and revokes the decrypted token in the background', async () => {
    setup();
    const id = await connect('frank@example.com');
    const res = await api(`/api/accounts/${id}`, { method: 'DELETE' });
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect(await jsonOf(await api('/api/accounts'))).toEqual({ accounts: [] });
    await vi.waitFor(() => expect(h.oauth.revoked).toEqual([`${REFRESH_TOKEN_PREFIX}frank@example.com`]));
    expect(h.drive.callsOf('trash')).toEqual([]);
    expect((await api(`/api/accounts/${id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('transfers: requests only write state and set the alarm', () => {
  it('validates the body like the Node host', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const bad = await api('/api/transfers', { method: 'POST', body: 'not json' });
    expect(bad.status).toBe(400);
    expect(await jsonOf(bad)).toMatchObject({ code: 'bad_request' });
    const noConfirm = await api('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({ mode: 'move', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: ['x'] }),
    });
    expect(noConfirm.status).toBe(400);
    expect(await jsonOf(noConfirm)).toMatchObject({ code: 'move_not_confirmed' });
    const unknown = await api('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({ mode: 'copy', sourceAccountId: a, destAccountId: 'nobody', destFolderId: 'root', sourceFileIds: ['x'] }),
    });
    expect(unknown.status).toBe(404);
    expect((await api('/api/transfers/does-not-exist')).status).toBe(404);
    expect((await api('/api/transfers/bad%20id')).status).toBe(400);
  });

  it('create sets the alarm without transferring; the alarm run completes the job', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const files = [h.drive.provider(a).addFile('root', 'one.bin', 100), h.drive.provider(a).addFile('root', 'two.bin', 200)];

    expect(await getAlarm()).toBeNull();
    const job = await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: files });
    expect(job.status).toBe('queued');
    expect(h.drive.callsOf(...TRANSFER_OPS)).toEqual([]);
    expect(await getAlarm()).not.toBeNull();

    const listed = await jsonOf<{ jobs: EngineTransferJob[] }>(await api('/api/transfers'));
    expect(listed.jobs.map((j) => j.id)).toEqual([job.id]);
    expect(listed.jobs[0]?.items).toBeUndefined();

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const done = await getJob(job.id);
    expect(done.status).toBe('completed');
    expect(done.items?.every((i) => i.status === 'done')).toBe(true);
    expect(h.drive.provider(b).tree().map((n) => n.name).sort()).toEqual(['one.bin', 'two.bin']);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(await getAlarm()).toBeNull(); // no work left: not re-armed
  });

  it('retry-failed and cancel only change state and schedule the alarm', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const file = h.drive.provider(a).addFile('root', 'x.bin', 10);
    const job = await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: [file] });

    const notFinished = await api(`/api/transfers/${job.id}/retry-failed`, { method: 'POST' });
    expect(notFinished.status).toBe(409);
    expect(await jsonOf(notFinished)).toMatchObject({ code: 'job_not_finished' });

    const canceled = await jsonOf<{ job: EngineTransferJob }>(await api(`/api/transfers/${job.id}/cancel`, { method: 'POST' }));
    expect(canceled.job.status).toBe('canceled');
    expect(h.drive.callsOf(...TRANSFER_OPS)).toEqual([]);

    await runInDurableObject(stub(), (_i, s) => s.storage.deleteAlarm());
    const retried = await jsonOf<{ job: EngineTransferJob }>(await api(`/api/transfers/${job.id}/retry-failed`, { method: 'POST' }));
    expect(retried.job.status).toBe('queued');
    expect(h.drive.callsOf(...TRANSFER_OPS)).toEqual([]);
    expect(await getAlarm()).not.toBeNull();

    await runDurableObjectAlarm(stub());
    expect((await getJob(job.id)).status).toBe('completed');
  });

  it('purge-trashed deletes forever only with explicit confirmation, after the move finished', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const file = h.drive.provider(a).addFile('root', 'big.bin', 10);
    const job = await createJob({
      mode: 'move',
      confirmMove: true,
      sourceAccountId: a,
      destAccountId: b,
      destFolderId: 'root',
      sourceFileIds: [file],
    });
    const post = (body: unknown) =>
      api(`/api/transfers/${job.id}/purge-trashed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const running = await post({ confirmPermanentDelete: true });
    expect(running.status).toBe(409);
    await runDurableObjectAlarm(stub());
    expect((await getJob(job.id)).trash).toEqual({ trashed: 1, purged: 0 });

    for (const body of [{}, { confirmPermanentDelete: 'yes' }]) {
      const refused = await post(body);
      expect(refused.status).toBe(400);
      expect(await jsonOf(refused)).toMatchObject({ code: 'purge_not_confirmed' });
    }
    expect(h.drive.callsOf('deleteTrashedForever')).toEqual([]);

    const done = await jsonOf<{ purged: number; remaining: number; job: EngineTransferJob }>(
      await post({ confirmPermanentDelete: true }),
    );
    expect(done).toMatchObject({ purged: 1, remaining: 0, job: { trash: { trashed: 0, purged: 1 } } });
    expect(h.drive.nodes.has(file)).toBe(false);
    expect(h.drive.provider(b).tree()).toEqual([{ name: 'big.bin', size: 10 }]);
  });
});

describe('alarm run budget', () => {
  it('stops at the wall-clock budget, pauses without failing anything and re-arms', async () => {
    setup({ timing: { runBudgetMs: 60 } });
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const files = Array.from({ length: 6 }, (_, i) => h.drive.provider(a).addFile('root', `f${i}.bin`, 10 + i));
    const gate = h.drive.provider(b).gate('copyWithin');
    const job = await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: files });

    setTimeout(() => gate.release(), 200);
    expect(await runDurableObjectAlarm(stub())).toBe(true); // resolves when the run is over
    expect(await getAlarm()).not.toBeNull(); // re-armed: work remains
    const paused = await getJob(job.id);
    expect(paused.status).toBe('queued');
    expect(paused.items?.some((i) => i.status === 'failed')).toBe(false);
    expect(paused.items?.some((i) => i.status === 'pending')).toBe(true);
    expect(h.drive.activePermissions()).toEqual([]);

    // Following runs (each capped at 60 ms) make progress until the job is done, then stop re-arming.
    let runs = 0;
    while ((await runDurableObjectAlarm(stub())) && runs < 20) runs++;
    expect((await getJob(job.id)).status).toBe('completed');
    expect(await getAlarm()).toBeNull();
  });

  it('counts every provider subrequest and ends the run when the subrequest budget is spent', async () => {
    setup({ subrequestsPerCall: 10, timing: { subrequestBudget: 120, subrequestSafetyMargin: 30 } });
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const files = Array.from({ length: 12 }, (_, i) => h.drive.provider(a).addFile('root', `g${i}.bin`, 10 + i));
    const gate = h.drive.provider(b).gate('copyWithin');
    const job = await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: files });
    const before = h.fetched.length;

    setTimeout(() => gate.release(), 300);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await getAlarm()).not.toBeNull();
    expect(h.fetched.length - before).toBeGreaterThanOrEqual(90);
    expect(h.fetched.every((url) => url.startsWith('https://www.googleapis.test/'))).toBe(true);
    const paused = await getJob(job.id);
    expect(paused.status).toBe('queued');
    expect(paused.items?.some((i) => i.status === 'failed')).toBe(false);
  });

  it('a re-created object (eviction) re-arms the alarm for unfinished work', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const file = h.drive.provider(a).addFile('root', 'r.bin', 10);
    await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: [file] });
    await runInDurableObject(stub(), (_i, s) => s.storage.deleteAlarm());
    expect(await getAlarm()).toBeNull();

    await evictDurableObject(stub());
    await api('/api/status'); // constructs the object again
    expect(await getAlarm()).not.toBeNull();
  });
});

describe('runs that cannot progress', () => {
  it('a job whose account needs reconnecting ends (terminal) and the alarm is not re-armed', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const file = h.drive.provider(a).addFile('root', 'n.bin', 10);
    const job = await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: [file] });
    await runInDurableObject(stub(), (_i, s) => {
      s.storage.sql.exec("UPDATE accounts SET status = 'needs_reconnect' WHERE id = ?", b);
    });
    await runDurableObjectAlarm(stub());
    const after = await getJob(job.id);
    expect(['failed', 'completed_with_errors', 'canceled']).toContain(after.status);
    expect(await getAlarm()).toBeNull();
  });

  it('backs off the re-arm delay while runs finish nothing, up to 15 minutes', async () => {
    setup({ timing: { reArmDelayMs: 1_000 } });
    await runInDurableObject(stub(), (instance: MultiCloudCore) => {
      const host = instance.host;
      expect(host.nextRunDelayMs()).toBe(1_000);
      host.stalledRuns = 1;
      expect(host.nextRunDelayMs()).toBe(2_000);
      host.stalledRuns = 3;
      expect(host.nextRunDelayMs()).toBe(8_000);
      host.stalledRuns = 50;
      expect(host.nextRunDelayMs()).toBe(15 * 60_000);
    });
  });

  it('cancel of a RUNNING job answers within the grace period; cleanup finishes in the run', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const files = Array.from({ length: 3 }, (_, i) => h.drive.provider(a).addFile('root', `c${i}.bin`, 10 + i));
    const gate = h.drive.provider(b).gate('copyWithin');
    const job = await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: files });

    // Run and cancel inside ONE object context: FakeDrive gate promises must not be resolved
    // across workerd I/O contexts (that crashes the test runtime, not the code under test).
    const { status, elapsed } = await runInDurableObject(stub(), async (instance: MultiCloudCore, state) => {
      await state.storage.deleteAlarm(); // as the platform does before invoking alarm()
      const run = instance.host.runAlarm();
      await gate.waitForCalls(1);
      const started = Date.now();
      const res = await instance.host.handle(
        new Request(`${ORIGIN}/api/transfers/${job.id}/cancel`, { method: 'POST', headers: { Origin: ORIGIN } }),
      );
      const result = { status: res.status, elapsed: Date.now() - started };
      gate.release();
      await run;
      return result;
    });
    expect(status).toBe(200);
    expect(elapsed).toBeLessThan(2_000);
    const after = await getJob(job.id);
    expect(after.status).toBe('canceled');
    expect(h.drive.activePermissions()).toEqual([]);
    expect(await getAlarm()).toBeNull();
  });
});

describe('production wiring (real core OAuth client and cipher, no fakes except env values)', () => {
  it('start redirects to Google with the redirect URI derived from the request host', async () => {
    const harness = createTestHarness();
    setHostDepsForTesting({ envOverride: harness.deps.envOverride, timing: harness.deps.timing });
    const res = await api('/api/auth/google/start');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location') ?? '');
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.test');
    expect(location.toString()).not.toContain('test-client-secret');
  });

  it('the real cipher round-trips a token through the BLOB column and agrees with isValidMasterKey', async () => {
    const { createTokenCipher } = await import('@multicloud/core');
    const { AccountsRepo } = await import('./accounts.ts');
    const { isValidMasterKey } = await import('./host.ts');
    expect(isValidMasterKey(TEST_MASTER_KEY)).toBe(true);
    const short = btoa('x'.repeat(31));
    expect(isValidMasterKey(short)).toBe(false);
    await expect(createTokenCipher(short)).rejects.toThrow();
    const cipher = await createTokenCipher(TEST_MASTER_KEY);
    setup();
    await runInDurableObject(stub(), async (_i, state) => {
      const repo = new AccountsRepo(state.storage);
      const account = repo.upsert({
        provider: 'google-drive',
        email: 'z@example.com',
        displayName: 'z',
        refreshTokenEnc: await cipher.encrypt('1//real-cipher-test-token'),
      });
      const blob = repo.getRefreshTokenEnc(account.id);
      expect(blob).not.toBeNull();
      expect(await cipher.decrypt(blob as Uint8Array)).toBe('1//real-cipher-test-token');
    });
  });
});

describe('safety', () => {
  it('a move trashes sources only after verification, removes temporary shares, keeps pre-existing ones', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const pa = h.drive.provider(a);
    const moved = pa.addFile('root', 'move-me.bin', 50);
    const shared = pa.addFile('root', 'shared-before.bin', 60);
    pa.preShare(shared, 'b@example.com');
    const job = await createJob({
      mode: 'move',
      confirmMove: true,
      sourceAccountId: a,
      destAccountId: b,
      destFolderId: 'root',
      sourceFileIds: [moved, shared],
    });
    await runDurableObjectAlarm(stub());
    const done = await getJob(job.id);
    expect(done.status).toBe('completed');
    expect(done.items?.every((i) => i.verified === true && i.sourceTrashed === true)).toBe(true);
    const sequence = h.drive.sequence('copyWithin', 'trash');
    expect(sequence.indexOf(`${a}:trash`)).toBeGreaterThan(sequence.indexOf(`${b}:copyWithin`));
    // Only the pre-existing share remains; the temporary one was removed.
    expect(h.drive.activePermissions()).toEqual([`${shared}:b@example.com`]);
  });
});

describe('event stream', () => {
  it('sends a keep-alive, then closes after the quiet period with a final stream.idle event', async () => {
    setup();
    const res = await api('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await res.text(); // resolves only because the server ends the stream
    expect(text.startsWith(':keep-alive\n\n')).toBe(true);
    expect(text).toContain(`event: ${SSE_IDLE_EVENT}\n`);
    expect(text).toMatch(/retry: \d+\n/);
  });

  it('stays open with heartbeats while a job is queued and streams job events without tokens', async () => {
    setup();
    const a = await connect('a@example.com');
    const b = await connect('b@example.com');
    const file = h.drive.provider(a).addFile('root', 's.bin', 10);
    await createJob({ mode: 'copy', sourceAccountId: a, destAccountId: b, destFolderId: 'root', sourceFileIds: [file] });

    const res = await api('/api/events');
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const decoder = new TextDecoder();
    let text = '';
    const started = Date.now();
    // Longer than the 120 ms quiet period: still open because work is queued.
    while (Date.now() - started < 400) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed while work was queued');
      text += decoder.decode(value);
    }
    expect(text.split(':keep-alive').length).toBeGreaterThan(2);
    expect(text).not.toContain(SSE_IDLE_EVENT);

    await runDurableObjectAlarm(stub());
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain('event: job.updated');
    expect(text).toContain('event: job.finished');
    expect(text).toContain(`event: ${SSE_IDLE_EVENT}`);
    expect(text).not.toContain(REFRESH_TOKEN_PREFIX);
    expect(text).not.toContain('access-for-');
  });
});
