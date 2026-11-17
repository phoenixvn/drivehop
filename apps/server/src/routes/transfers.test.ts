import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { ProviderError, SSE_EVENT_TYPES } from '@multicloud/shared';
import type { ApiError, SseEvent, TransferJob } from '@multicloud/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { LISTEN_HOST, buildServer } from '../app.ts';
import type { BuildServerOptions, BuiltServer } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createStaticKeySource } from '../crypto/keySource.ts';
import { openDatabase } from '../db/index.ts';
import { FakeDrive } from '@multicloud/core/testing';
import type { FakeProvider } from '@multicloud/core/testing';

interface Ctx extends BuiltServer {
  drive: FakeDrive;
  /** Account ids as stored in the server database. */
  idA: string;
  idB: string;
  a: FakeProvider;
  b: FakeProvider;
}

const servers: BuiltServer[] = [];

async function start(options: Partial<BuildServerOptions> & { configured?: boolean } = {}): Promise<Ctx> {
  const { configured = true, ...rest } = options;
  const drive = new FakeDrive();
  const server = await buildServer({
    config: loadConfig({
      envFile: null,
      env: {
        PORT: '8791',
        WEB_ORIGIN: 'http://localhost:5173',
        DATA_DIR: path.join(os.tmpdir(), 'multicloud-test-unused'),
        ...(configured ? { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret-fixture' } : {}),
      },
    }),
    db: openDatabase({ memory: true }),
    keySource: createStaticKeySource(randomBytes(32)),
    oauth: null,
    logger: false,
    providers: {
      resolveProvider: async (accountId) => drive.provider(accountId),
      getAccountEmail: (accountId) => drive.email(accountId),
    },
    // No real waiting between retries, no event throttling.
    engine: { sleep: async () => {}, random: () => 1, progressThrottleMs: 0 },
    ...rest,
  });
  servers.push(server);
  const add = (email: string): { id: string; provider: FakeProvider } => {
    const { account } = server.accounts.upsert({
      provider: 'google-drive',
      email,
      displayName: email,
      refreshTokenEnc: Buffer.from('not-a-real-token'),
    });
    return { id: account.id, provider: drive.addAccount(account.id, email) };
  };
  const a = add('a@example.com');
  const b = add('b@example.com');
  return { ...server, drive, idA: a.id, idB: b.id, a: a.provider, b: b.provider };
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.app.close();
});

function post(ctx: Ctx, url: string, payload?: unknown) {
  return ctx.app.inject({
    method: 'POST',
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function copyBody(ctx: Ctx, sourceFileIds: string[], extra: Record<string, unknown> = {}) {
  return {
    mode: 'copy',
    sourceAccountId: ctx.idA,
    destAccountId: ctx.idB,
    destFolderId: 'root',
    sourceFileIds,
    ...extra,
  };
}

function expectApiError(res: { statusCode: number; json: () => unknown }, statusCode: number, code: string): void {
  expect(res.statusCode).toBe(statusCode);
  const body = res.json() as ApiError;
  expect(body.code).toBe(code);
  expect(typeof body.message).toBe('string');
  expect(Object.keys(body).sort()).toEqual(['code', 'message']);
}

/** Incremental parser of a text/event-stream body. */
function sseReader(stream: Readable) {
  let buffer = '';
  const comments: string[] = [];
  const events: Array<{ event: string | null; data: string }> = [];
  const waiters: Array<() => void> = [];
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) comments.push(line);
        else if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
        else throw new Error(`unexpected SSE line: ${line}`);
      }
      if (data.length > 0) events.push({ event, data: data.join('\n') });
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for SSE data');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return { comments, events, until };
}

describe('POST /api/transfers', () => {
  it('runs a copy to completion and exposes it through GET /api/transfers/:id', async () => {
    const ctx = await start();
    const folder = ctx.a.addFolder('root', 'Tài liệu');
    ctx.a.addFile(folder, 'ghi chú.txt', 'xin chào');
    const file = ctx.a.addFile('root', 'ảnh.bin', 2048);

    const created = await post(ctx, '/api/transfers', copyBody(ctx, [folder, file]));
    expect(created.statusCode).toBe(201);
    const { job } = created.json<{ job: TransferJob }>();
    expect(job).toMatchObject({
      mode: 'copy',
      sourceAccountId: ctx.idA,
      destAccountId: ctx.idB,
      destFolderId: 'root',
      status: 'queued',
    });

    await ctx.engine.waitForJob(job.id);

    const fetched = await ctx.app.inject({ method: 'GET', url: `/api/transfers/${job.id}` });
    expect(fetched.statusCode).toBe(200);
    const done = fetched.json<{ job: TransferJob }>().job;
    expect(done.status).toBe('completed');
    expect(done.finishedAt).toBeDefined();
    expect(done.error).toBeUndefined();
    expect(done.totals).toMatchObject({ items: 3, done: 3, failed: 0 });
    expect(done.items?.map((item) => [item.name, item.status, item.verified]).sort()).toEqual([
      ['Tài liệu', 'done', true],
      ['ghi chú.txt', 'done', true],
      ['ảnh.bin', 'done', true],
    ]);
    expect(done.items?.every((item) => typeof item.bytesDone === 'number')).toBe(true);

    // The copy is in the destination account, the source is untouched, nothing stays shared.
    expect(ctx.b.childrenOf('root').map((node) => node.name).sort()).toEqual(['Tài liệu', 'ảnh.bin']);
    expect(ctx.a.childrenOf('root')).toHaveLength(2);
    expect(ctx.drive.callsOf('trash')).toEqual([]);
    expect(ctx.drive.activePermissions()).toEqual([]);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/transfers' });
    expect(list.statusCode).toBe(200);
    const jobs = list.json<{ jobs: TransferJob[] }>().jobs;
    expect(jobs.map((j) => j.id)).toEqual([job.id]);
    expect(jobs[0]?.items).toBeUndefined();
  });

  it('rejects a move without confirmMove with 400 move_not_confirmed and creates nothing', async () => {
    const ctx = await start();
    const file = ctx.a.addFile('root', 'a.bin', 10);
    // Anything but the boolean `true` is not a confirmation.
    for (const extra of [{}, { confirmMove: false }, { confirmMove: 'true' }, { confirmMove: 1 }, { confirmMove: null }]) {
      const res = await post(ctx, '/api/transfers', copyBody(ctx, [file], { mode: 'move', ...extra }));
      expectApiError(res, 400, 'move_not_confirmed');
    }
    expect(ctx.engine.listJobs()).toEqual([]);
    expect(ctx.drive.calls).toEqual([]);
  });

  it('moves only after confirmation: copy, verify, then trash (never delete) the source', async () => {
    const ctx = await start();
    const file = ctx.a.addFile('root', 'a.bin', 10);
    const res = await post(ctx, '/api/transfers', copyBody(ctx, [file], { mode: 'move', confirmMove: true }));
    expect(res.statusCode).toBe(201);
    const job = await ctx.engine.waitForJob(res.json<{ job: TransferJob }>().job.id);
    expect(job.status).toBe('completed');
    expect(job.items?.[0]).toMatchObject({ status: 'done', verified: true, sourceTrashed: true });
    expect(ctx.drive.callsOf('trash').map((call) => call.target)).toEqual([file]);
    expect(ctx.b.childrenOf('root').map((node) => node.name)).toEqual(['a.bin']);
    expect(ctx.drive.activePermissions()).toEqual([]);
  });

  it('rejects an unknown account with 404 not_found', async () => {
    const ctx = await start();
    const file = ctx.a.addFile('root', 'a.bin', 10);
    expectApiError(
      await post(ctx, '/api/transfers', copyBody(ctx, [file], { sourceAccountId: 'no-such-account' })),
      404,
      'not_found',
    );
    expectApiError(
      await post(ctx, '/api/transfers', copyBody(ctx, [file], { destAccountId: 'no-such-account' })),
      404,
      'not_found',
    );
    expect(ctx.engine.listJobs()).toEqual([]);
    expect(ctx.drive.calls).toEqual([]);
  });

  it('rejects invalid input with 400 bad_request', async () => {
    const ctx = await start();
    const file = ctx.a.addFile('root', 'a.bin', 10);
    const many = Array.from({ length: 501 }, (_, i) => `file-${i}`);
    const bad: unknown[] = [
      undefined,
      {},
      copyBody(ctx, ["a' or '1'='1"]),
      copyBody(ctx, ['../etc/passwd']),
      copyBody(ctx, ['a b']),
      copyBody(ctx, ['x'.repeat(129)]),
      copyBody(ctx, [file, file]),
      copyBody(ctx, []),
      copyBody(ctx, many),
      copyBody(ctx, [file], { destFolderId: 'bad/id' }),
      copyBody(ctx, [file], { destFolderId: '' }),
      copyBody(ctx, [file], { mode: 'delete' }),
      copyBody(ctx, [file], { sourceAccountId: 'bad id' }),
      copyBody(ctx, [file], { sourceFileIds: 'not-an-array' }),
    ];
    for (const payload of bad) {
      const res = await post(ctx, '/api/transfers', payload);
      expect([JSON.stringify(payload)?.slice(0, 80), res.statusCode]).toEqual([
        JSON.stringify(payload)?.slice(0, 80),
        400,
      ]);
      expectApiError(res, 400, 'bad_request');
    }
    expect(ctx.engine.listJobs()).toEqual([]);
    expect(ctx.drive.calls).toEqual([]);
  });

  it('maps engine rejections (TransferError) to their code and status', async () => {
    const ctx = await start();
    const folder = ctx.a.addFolder('root', 'Thư mục');
    const file = ctx.a.addFile('root', 'a.bin', 10);
    const sameAccount = { destAccountId: ctx.idA };
    expectApiError(
      await post(ctx, '/api/transfers', copyBody(ctx, [folder], { ...sameAccount, destFolderId: folder })),
      400,
      'dest_inside_source',
    );
    expectApiError(
      await post(ctx, '/api/transfers', copyBody(ctx, [file], { ...sameAccount, mode: 'move', confirmMove: true })),
      400,
      'same_folder_move',
    );
    expect(ctx.drive.callsOf('trash')).toEqual([]);
  });

  it('answers 503 not_configured without Google credentials, and the other transfer routes still work', async () => {
    const ctx = await start({ configured: false });
    const res = await post(ctx, '/api/transfers', copyBody(ctx, ['some-file']));
    expectApiError(res, 503, 'not_configured');
    expect(res.json<ApiError>().message).toContain('GOOGLE_CLIENT_ID');

    const list = await ctx.app.inject({ method: 'GET', url: '/api/transfers' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ jobs: [] });
  });
});

describe('transfer job routes', () => {
  it('answers 404 for unknown job ids and 400 for malformed ones', async () => {
    const ctx = await start();
    expectApiError(await ctx.app.inject({ method: 'GET', url: '/api/transfers/nope' }), 404, 'not_found');
    expectApiError(await post(ctx, '/api/transfers/nope/cancel'), 404, 'not_found');
    expectApiError(await post(ctx, '/api/transfers/nope/retry-failed'), 404, 'not_found');
    expectApiError(await ctx.app.inject({ method: 'GET', url: '/api/transfers/bad%20id' }), 400, 'bad_request');
  });

  it('cancel answers promptly while a provider call is still in flight; the job ends canceled', async () => {
    const ctx = await start({ cancelGraceMs: 20 });
    const file = ctx.a.addFile('root', 'a.bin', 10);
    const gate = ctx.b.gate('copyWithin');
    const created = await post(ctx, '/api/transfers', copyBody(ctx, [file]));
    const id = created.json<{ job: TransferJob }>().job.id;
    await gate.waitForCalls(1);

    // The gate is still closed: the engine cannot finish, yet the response arrives.
    const res = await post(ctx, `/api/transfers/${id}/cancel`);
    expect(res.statusCode).toBe(200);
    const snapshot = res.json<{ job: TransferJob }>().job;
    expect(snapshot.status).toBe('running');
    expect(snapshot.items).toHaveLength(1);

    // Retrying the failed items of a job that has not finished is refused.
    expectApiError(await post(ctx, `/api/transfers/${id}/retry-failed`), 409, 'job_not_finished');

    gate.release();
    const final = await ctx.engine.waitForJob(id);
    expect(final.status).toBe('canceled');
    // The temporary share made for the copy was removed even though the job was canceled.
    expect(ctx.drive.callsOf('shareWithAccount')).toHaveLength(1);
    expect(ctx.drive.activePermissions()).toEqual([]);

    // Canceling a finished job is a no-op that returns it.
    const again = await post(ctx, `/api/transfers/${id}/cancel`);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ job: TransferJob }>().job.status).toBe('canceled');
  });

  it('cancel returns the canceled job when the engine stops within the grace period', async () => {
    const ctx = await start();
    const file = ctx.a.addFile('root', 'a.bin', 10);
    const gate = ctx.b.gate('copyWithin');
    const created = await post(ctx, '/api/transfers', copyBody(ctx, [file]));
    const id = created.json<{ job: TransferJob }>().job.id;
    await gate.waitForCalls(1);
    const canceling = post(ctx, `/api/transfers/${id}/cancel`);
    setTimeout(() => gate.release(), 10);
    const res = await canceling;
    expect(res.statusCode).toBe(200);
    expect(res.json<{ job: TransferJob }>().job.status).toBe('canceled');
  });

  it('retry-failed re-queues a job (non-terminal response) and the failed item then succeeds', async () => {
    const ctx = await start({ engine: { sleep: async () => {}, progressThrottleMs: 0, retry: { maxAttempts: 1 } } });
    const good = ctx.a.addFile('root', 'good.bin', 10);
    const flaky = ctx.a.addFile('root', 'flaky.bin', 10, { canCopy: false });
    const { fakeError } = await import('@multicloud/core/testing');
    ctx.a.failNext('downloadStream', fakeError('forbidden', 403), 1, flaky);

    const created = await post(ctx, '/api/transfers', copyBody(ctx, [good, flaky]));
    const id = created.json<{ job: TransferJob }>().job.id;
    const first = await ctx.engine.waitForJob(id);
    expect(first.status).toBe('completed_with_errors');
    expect(first.totals.failed).toBe(1);
    expect(first.items?.find((item) => item.name === 'flaky.bin')?.error).toMatch(/^forbidden/);

    const retried = await post(ctx, `/api/transfers/${id}/retry-failed`);
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ job: TransferJob }>().job.status).toBe('queued');

    const second = await ctx.engine.waitForJob(id);
    expect(second.status).toBe('completed');
    expect(second.totals).toMatchObject({ items: 2, done: 2, failed: 0 });
    expect(ctx.b.childrenOf('root').map((node) => node.name).sort()).toEqual(['flaky.bin', 'good.bin']);
  });
});

describe('secrets', () => {
  it('never returns or streams token-like text from upstream error messages', async () => {
    const ctx = await start({ engine: { sleep: async () => {}, progressThrottleMs: 0, retry: { maxAttempts: 1 } } });
    const file = ctx.a.addFile('root', 'a.bin', 10, { canCopy: false });
    const leaky = new ProviderError(
      'Google Drive 403: request to https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION-CAPABILITY failed with Authorization: Bearer ya29.A0ARrdaM-secret, refresh 1//0gSecretRefresh, GOCSPX-clientSecret',
      { kind: 'forbidden', retryable: false, status: 403 },
    );
    ctx.a.failNext('downloadStream', leaky, 1, file);
    const seen: string[] = [];
    ctx.engine.subscribe((event) => seen.push(JSON.stringify(event)));

    const created = await post(ctx, '/api/transfers', copyBody(ctx, [file]));
    const id = created.json<{ job: TransferJob }>().job.id;
    await ctx.engine.waitForJob(id);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/transfers/${id}` });
    const job = res.json<{ job: TransferJob }>().job;
    expect(job.status).toBe('failed');
    expect(job.items?.[0]?.error).toMatch(/^forbidden: /);
    expect(job.error).toMatch(/^forbidden: /);

    const everything = [res.body, ...seen].join('\n');
    expect(everything).toContain('[redacted]');
    for (const secret of ['ya29', 'A0ARrdaM', 'SESSION-CAPABILITY', '0gSecretRefresh', 'clientSecret']) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('GET /api/events', () => {
  it('streams the events of a created job as named SSE events carrying {type, payload}', async () => {
    const ctx = await start();
    const file = ctx.a.addFile('root', 'a.bin', 10);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { origin: 'http://localhost:5173' },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const reader = sseReader(res.stream());

    // The stream is attached once the immediate keep-alive comment arrived.
    await reader.until(() => reader.comments.length > 0);
    expect(reader.comments[0]).toBe(':keep-alive');

    const created = await post(ctx, '/api/transfers', copyBody(ctx, [file]));
    const id = created.json<{ job: TransferJob }>().job.id;
    await ctx.engine.waitForJob(id);
    await reader.until(() => reader.events.some((e) => e.event === 'job.finished'));

    const parsed = reader.events.map((raw) => {
      // Wire format: `event: <type>` + `data: <JSON of the whole event>`.
      expect(SSE_EVENT_TYPES).toContain(raw.event);
      const event = JSON.parse(raw.data) as SseEvent;
      expect(Object.keys(event).sort()).toEqual(['payload', 'type']);
      expect(event.type).toBe(raw.event);
      return event;
    });
    expect(parsed[0]).toMatchObject({ type: 'job.created', payload: { job: { id, status: 'queued' } } });
    expect(parsed.at(-1)).toMatchObject({ type: 'job.finished', payload: { job: { id, status: 'completed' } } });
    const types = parsed.map((event) => event.type);
    expect(types).toContain('job.updated');
    expect(types).toContain('item.updated');
    const statuses = parsed.flatMap((event) => (event.type === 'job.updated' ? [event.payload.job.status] : []));
    expect(statuses).toContain('running');
    expect(statuses).toContain('verifying');
    const lastItem = parsed.findLast((event) => event.type === 'item.updated');
    expect(lastItem).toMatchObject({
      payload: { jobId: id, item: { sourceId: file, status: 'done', verified: true } },
    });
    // Jobs inside events never carry their items.
    for (const event of parsed) {
      if (event.type !== 'item.updated') expect(event.payload.job.items).toBeUndefined();
    }
  });

  it('gives no CORS headers to other origins and rejects foreign Host names', async () => {
    const ctx = await start();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { origin: 'http://evil.example' },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    res.stream().destroy();

    const foreign = await ctx.app.inject({ method: 'GET', url: '/api/events', headers: { host: 'evil.example' } });
    expectApiError(foreign, 403, 'bad_request');
  });

  it('over a real socket: keep-alive at once, events arrive, and app.close() ends open streams', async () => {
    const ctx = await start({ sseKeepAliveMs: 25 });
    const file = ctx.a.addFile('root', 'a.bin', 10);
    await ctx.app.listen({ host: LISTEN_HOST, port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get({ host: LISTEN_HOST, port, path: '/api/events', headers: { accept: 'text/event-stream' } }, resolve)
        .on('error', reject);
    });
    expect(response.statusCode).toBe(200);
    const ended = new Promise<void>((resolve) => response.on('close', resolve));
    const reader = sseReader(response);
    await reader.until(() => reader.comments.length >= 3); // the immediate one plus periodic ones

    const created = await post(ctx, '/api/transfers', copyBody(ctx, [file]));
    const id = created.json<{ job: TransferJob }>().job.id;
    await reader.until(() => reader.events.some((e) => e.event === 'job.finished'));
    expect(JSON.parse(reader.events.at(-1)?.data ?? '{}')).toMatchObject({
      type: 'job.finished',
      payload: { job: { id, status: 'completed' } },
    });

    // An open stream must not keep the server from shutting down.
    await ctx.app.close();
    await ended;
    // The engine was shut down with the server (the injected database stays open for its owner).
    await expect(ctx.engine.createJob(copyBody(ctx, [file]) as never)).rejects.toMatchObject({
      code: 'engine_closed',
    });
  });
});
