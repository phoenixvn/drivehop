import { afterEach, describe, expect, it } from 'vitest';
import type { CreateTransferRequest } from '@multicloud/shared';
import { createHarness } from './testing/harness.ts';
import type { Harness } from './testing/harness.ts';
import { fakeError } from './testing/FakeProvider.ts';
import type { FakeCall, FakeOp, FakeProvider } from './testing/FakeProvider.ts';
import type { TransferEngineHandle, TransferEngineOptions } from './index.ts';

// Interruptions are routine on Cloudflare (alarm runs end, the Durable Object is evicted), so every
// create at the destination carries a preset id that is persisted first. These tests prove a
// resumed or repeated create never yields a second object, and that the move/share safety rules
// still hold on those new paths.

let h: Harness;
const engines: TransferEngineHandle[] = [];

const setup = (options?: TransferEngineOptions): Harness => {
  h = createHarness(options);
  return h;
};

afterEach(async () => {
  await h.engine.close();
  for (const engine of engines.splice(0)) await engine.close();
  h.db.close();
});

function request(ids: string[], mode: 'copy' | 'move' = 'copy', dest = 'acc-b'): CreateTransferRequest {
  return {
    mode,
    sourceAccountId: 'acc-a',
    destAccountId: dest,
    destFolderId: 'root',
    sourceFileIds: ids,
    ...(mode === 'move' ? { confirmMove: true } : {}),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function presetArg(call: FakeCall | undefined): string | undefined {
  const last = call?.args.at(-1) as { presetId?: string } | undefined;
  return typeof last === 'object' && last !== null ? last.presetId : undefined;
}

function rowOf(sourceId: string): { status: string; dest_id: string | null; dest_preset_id: string | null } {
  const row = h.db
    .prepare('SELECT status, dest_id, dest_preset_id FROM transfer_items WHERE source_id = ?')
    .get(sourceId) as { status: string; dest_id: string | null; dest_preset_id: string | null } | undefined;
  if (!row) throw new Error(`no item for ${sourceId}`);
  return row;
}

/** Live (non-trashed) objects per name directly below a destination folder. */
function namesBelow(provider: FakeProvider, folderId = 'root'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of provider.childrenOf(folderId)) counts[node.name] = (counts[node.name] ?? 0) + 1;
  return counts;
}

/** Restarts the host: a new engine on the same database (the old one was paused first). */
function restartManual(): TransferEngineHandle {
  const next = h.restart({ manual: true });
  engines.push(next);
  return next;
}

describe('preset ids are persisted before the create call', () => {
  const cases: Array<{ op: FakeOp; arrange: () => string }> = [
    { op: 'copyWithin', arrange: () => h.a.addFile('root', 'copy.bin', 'hello') },
    { op: 'resumableUploadFromStream', arrange: () => h.a.addFile('root', 'up.bin', 'hello', { canCopy: false }) },
    { op: 'createFolder', arrange: () => h.a.addFolder('root', 'dir') },
  ];
  for (const { op, arrange } of cases) {
    it(`${op}: generateIds first, the id on the row while the call is in flight`, async () => {
      setup();
      const sourceId = arrange();
      const gate = h.b.gate(op);

      const created = await h.engine.createJob(request([sourceId]));
      await gate.waitForCalls(1);

      const blocked = h.drive.callsOf(op).at(-1);
      const presetId = presetArg(blocked);
      expect(presetId).toEqual(expect.any(String));
      // Persisted BEFORE the call: the row already carries the id the call uses.
      expect(rowOf(sourceId).dest_preset_id).toBe(presetId);
      const generate = h.drive.callsOf('generateIds').filter((c) => c.accountId === 'acc-b');
      expect(generate.length).toBeGreaterThan(0);
      expect(generate[0]!.seq).toBeLessThan(blocked!.seq);

      gate.release();
      const job = await h.engine.waitForJob(created.id);
      expect(job.status).toBe('completed');
      expect(job.items?.[0]?.destId).toBe(presetId);
    });
  }

  it('reserves ids in batches, not one call per item', async () => {
    setup();
    const files = Array.from({ length: 12 }, (_, i) => h.a.addFile('root', `f${i}.bin`, 10 + i));
    const job = await h.engine.waitForJob((await h.engine.createJob(request(files))).id);
    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('generateIds')).toHaveLength(1);
    const used = h.drive.callsOf('copyWithin').map(presetArg);
    expect(new Set(used).size).toBe(12);
  });
});

describe('response lost after the create succeeded', () => {
  it('a retryable loss is resolved in the same run through the preset id: one copy', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 'hello');
    h.b.loseResponseNext('copyWithin');

    const job = await h.engine.waitForJob((await h.engine.createJob(request([file]))).id);

    expect(job.status).toBe('completed');
    const copies = h.drive.callsOf('copyWithin');
    expect(copies).toHaveLength(2); // the retry is refused with 409, then looked up
    expect(presetArg(copies[0])).toBe(presetArg(copies[1]));
    expect(namesBelow(h.b)).toEqual({ 'a.bin': 1 });
    expect(job.items?.[0]).toMatchObject({ status: 'done', verified: true, destId: presetArg(copies[0]) });
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('a non-retryable loss finds the copy instead of falling back (no stream, no cap, no native failure)', async () => {
    setup({ maxStreamBytes: 1 });
    const file = h.a.addFile('root', 'big.bin', 5000);
    const doc = h.a.addGoogleDoc('root', 'doc');
    h.b.loseResponseNext('copyWithin', () => fakeError('unknown'), 2);

    const job = await h.engine.waitForJob((await h.engine.createJob(request([file, doc]))).id);

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('downloadStream', 'resumableUploadFromStream')).toEqual([]);
    expect(h.drive.callsOf('copyWithin')).toHaveLength(2);
    expect(namesBelow(h.b)).toEqual({ 'big.bin': 1, doc: 1 });
    expect(job.items?.every((i) => i.strategyUsed === 'permission-copy')).toBe(true);
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('a stream upload whose response was lost is found too', async () => {
    setup();
    const file = h.a.addFile('root', 'up.bin', 300_000, { canCopy: false });
    h.b.loseResponseNext('resumableUploadFromStream');

    const job = await h.engine.waitForJob((await h.engine.createJob(request([file]))).id);

    expect(job.status).toBe('completed');
    expect(namesBelow(h.b)).toEqual({ 'up.bin': 1 });
  });

  it('paused while the lost copy is retried, the resumed host finds it by the preset id', async () => {
    setup({ manual: true });
    const file = h.a.addFile('root', 'a.bin', 'hello');
    const other = h.a.addFile('root', 'b.bin', 'world');
    const gate = h.b.gate('copyWithin', file);
    h.b.loseResponseNext('copyWithin', undefined, 1, file);

    const created = await h.engine.createJob(request([file, other]));
    h.engine.start();
    await gate.waitForCalls(1);
    const pausing = h.engine.pause();
    gate.release();
    await pausing;

    // The copy exists at the destination, the engine never saw its id; nothing is failed.
    const row = rowOf(file);
    expect(row.status).toBe('pending');
    expect(row.dest_id).toBeNull();
    expect(row.dest_preset_id).toEqual(expect.any(String));
    expect(h.b.node(row.dest_preset_id!).name).toBe('a.bin');
    expect(h.engine.getJob(created.id)?.items?.some((i) => i.status === 'failed')).toBe(false);
    expect(h.drive.activePermissions()).toEqual([]);

    const copiesBefore = h.drive.callsOf('copyWithin').filter((c) => c.target === file).length;
    const next = restartManual();
    next.start();
    const job = await next.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('copyWithin').filter((c) => c.target === file)).toHaveLength(copiesBefore);
    const lookups = h.drive.callsOf('getFile').filter((c) => c.accountId === 'acc-b' && c.target === row.dest_preset_id);
    expect(lookups.length).toBeGreaterThan(0);
    expect(namesBelow(h.b)).toEqual({ 'a.bin': 1, 'b.bin': 1 });
    expect(job.items?.find((i) => i.sourceId === file)).toMatchObject({ destId: row.dest_preset_id, verified: true });
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('a host that died after the copy but before recording it resumes without a second copy', async () => {
    setup({ manual: true });
    const file = h.a.addFile('root', 'a.bin', 'hello');
    const created = await h.engine.createJob(request([file]));
    // What the dead host left: the reserved id persisted, the copy made, the share still live.
    const [presetId] = await h.b.generateIds(1);
    const { permissionId } = await h.a.shareWithAccount(file, 'b@example.com');
    await h.b.copyWithin(file, 'root', 'a.bin', { presetId: presetId! });
    h.db.prepare(`UPDATE transfer_jobs SET status = 'running' WHERE id = ?`).run(created.id);
    h.db
      .prepare(`INSERT INTO transfer_items (id, job_id, depth, source_id, name, status, permission_id, meta_loaded,
                  can_copy, can_download, size_bytes, strategy_used, dest_preset_id)
                VALUES ('dead-item', ?, 0, ?, 'a.bin', 'running', ?, 1, 1, 1, 5, 'permission-copy', ?)`)
      .run(created.id, file, permissionId, presetId);
    const callsBefore = h.drive.calls.length;

    const next = restartManual();
    next.start();
    const job = await next.waitForJob(created.id);

    expect(job.status).toBe('completed');
    const after = h.drive.calls.slice(callsBefore).map((c) => `${c.accountId}:${c.op}`);
    expect(after).not.toContain('acc-b:copyWithin');
    expect(after).not.toContain('acc-a:shareWithAccount');
    expect(after).toContain('acc-a:unshare');
    expect(namesBelow(h.b)).toEqual({ 'a.bin': 1 });
    expect(job.items?.[0]).toMatchObject({ status: 'done', verified: true, destId: presetId });
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('never records or removes a share the owner made earlier, also on the lost-response path', async () => {
    setup();
    const file = h.a.addFile('root', 'shared.bin', 'hello');
    const ownerShare = h.a.preShare(file, 'b@example.com');
    h.b.loseResponseNext('copyWithin', () => fakeError('unknown'));

    const job = await h.engine.waitForJob((await h.engine.createJob(request([file]))).id);

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('unshare')).toEqual([]);
    expect(h.a.node(file).permissions.get(ownerShare)).toBe('b@example.com');
    expect(h.db.prepare('SELECT permission_id FROM transfer_items').all()).toEqual([{ permission_id: null }]);
    expect(namesBelow(h.b)).toEqual({ 'shared.bin': 1 });
  });

  it('a paused move with a lost copy trashes nothing until every item verified, and never deletes', async () => {
    setup({ manual: true, itemConcurrency: 1 });
    const files = ['m0.bin', 'm1.bin', 'm2.bin'].map((name) => h.a.addFile('root', name, name));
    const gate = h.b.gate('copyWithin', files[1]);
    h.b.loseResponseNext('copyWithin', undefined, 1, files[1]);

    const created = await h.engine.createJob(request(files, 'move'));
    h.engine.start();
    await gate.waitForCalls(1);
    const pausing = h.engine.pause();
    gate.release();
    await pausing;
    expect(h.drive.callsOf('trash')).toEqual([]);

    const next = restartManual();
    next.start();
    const job = await next.waitForJob(created.id);

    expect(job.status).toBe('completed');
    const order = h.drive.callsOf('copyWithin', 'trash').map((c) => c.op);
    expect(order.slice(-3)).toEqual(['trash', 'trash', 'trash']);
    expect(order.indexOf('trash')).toBe(order.length - 3);
    expect(namesBelow(h.b)).toEqual({ 'm0.bin': 1, 'm1.bin': 1, 'm2.bin': 1 });
    // Trash is the only destructive operation, and the sources are recoverable there.
    expect(files.every((id) => h.a.node(id).trashed)).toBe(true);
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('a move whose looked-up copy fails verification trashes nothing', async () => {
    setup();
    const file = h.a.addFile('root', 'v.bin', 'verify me');
    h.b.corruptNextWrites = 1;
    h.b.loseResponseNext('copyWithin');

    const job = await h.engine.waitForJob((await h.engine.createJob(request([file], 'move'))).id);

    expect(h.drive.callsOf('trash')).toEqual([]);
    expect(h.a.node(file).trashed).toBe(false);
    expect(job.items?.[0]?.error).toMatch(/^verification_failed/);
    expect(job.error).toMatch(/^verification_failed|^move_not_verified/);
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('an unconfirmed move never trashes, even when every copy needed a lookup', async () => {
    setup({ manual: true });
    const file = h.a.addFile('root', 'x.bin', 'x');
    h.b.loseResponseNext('copyWithin');
    const created = await h.engine.createJob(request([file], 'copy'));
    // Force the stored job into an unconfirmed move (createJob refuses one).
    h.db.prepare(`UPDATE transfer_jobs SET mode = 'move', confirm_move = 0 WHERE id = ?`).run(created.id);
    h.engine.start();

    const job = await h.engine.waitForJob(created.id);

    expect(h.drive.callsOf('trash')).toEqual([]);
    expect(job.error).toMatch(/^move_not_confirmed/);
    expect(h.a.node(file).trashed).toBe(false);
  });
});

describe('folders in recursive copies', () => {
  function tree(): string {
    const top = h.a.addFolder('root', 'top');
    const sub = h.a.addFolder(top, 'sub');
    h.a.addFile(top, 't.bin', 'top file');
    h.a.addFile(sub, 's1.bin', 'one');
    h.a.addFile(sub, 's2.bin', 'two');
    return top;
  }
  const expected = [
    {
      name: 'top',
      children: [
        { name: 'sub', children: [{ name: 's1.bin', size: 3 }, { name: 's2.bin', size: 3 }] },
        { name: 't.bin', size: 8 },
      ],
    },
  ];

  it('a lost createFolder response is resolved by the preset id: one folder', async () => {
    setup();
    const top = tree();
    h.b.loseResponseNext('createFolder', undefined, 1, 'root');

    const job = await h.engine.waitForJob((await h.engine.createJob(request([top]))).id);

    expect(job.status).toBe('completed');
    expect(h.b.tree()).toEqual(expected);
    expect(h.drive.callsOf('createFolder')).toHaveLength(3); // top twice (409 on the retry), sub once
  });

  it('paused while a lost folder create is retried, the resumed job has no duplicate folder', async () => {
    setup({ manual: true });
    const top = tree();
    const gate = h.b.gate('createFolder');
    h.b.loseResponseNext('createFolder');

    const created = await h.engine.createJob(request([top]));
    h.engine.start();
    await gate.waitForCalls(1);
    const pausing = h.engine.pause();
    gate.release();
    await pausing;

    expect(rowOf(top)).toMatchObject({ status: 'pending', dest_id: null });
    expect(h.b.childrenOf('root').map((n) => n.name)).toEqual(['top']);

    const next = restartManual();
    next.start();
    const job = await next.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(h.b.tree()).toEqual(expected);
    expect(h.drive.callsOf('createFolder').filter((c) => c.args[1] === 'top')).toHaveLength(1);
  });
});

describe('retry after a genuine failure', () => {
  it('reuses the persisted id when nothing was created', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 'hello', { canDownload: false });
    h.b.failNext('copyWithin', fakeError('forbidden', 403));

    const created = await h.engine.createJob(request([file]));
    const failed = await h.engine.waitForJob(created.id);
    expect(failed.status).toBe('failed');
    const reserved = rowOf(file).dest_preset_id;
    expect(reserved).toEqual(expect.any(String));

    await h.engine.retryFailed(created.id);
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('copyWithin').map(presetArg)).toEqual([reserved, reserved]);
    expect(h.drive.callsOf('generateIds')).toHaveLength(1);
    expect(namesBelow(h.b)).toEqual({ 'a.bin': 1 });
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('a copy that exists but differs is kept (never deleted) and a new id is reserved for the new copy', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 'hello');
    h.b.corruptNextWrites = 1;

    const created = await h.engine.createJob(request([file]));
    expect((await h.engine.waitForJob(created.id)).status).toBe('failed');
    const first = rowOf(file);

    await h.engine.retryFailed(created.id);
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('completed');
    const second = rowOf(file);
    expect(second.dest_preset_id).not.toBe(first.dest_preset_id);
    expect(second.dest_id).toBe(second.dest_preset_id);
    expect(h.b.node(first.dest_id!).trashed).toBe(false);
    expect(h.drive.callsOf('trash')).toEqual([]);
  });
});

describe('a 100-file job interrupted many times', () => {
  it('ends with every file done once, no duplicates, no leftover permissions, nothing ever failed', async () => {
    setup({ manual: true, itemConcurrency: 4 });
    const names = Array.from({ length: 100 }, (_, i) => `file-${String(i).padStart(3, '0')}.bin`);
    const files = names.map((name, i) => h.a.addFile('root', name, 50 + i, i % 10 === 0 ? { canCopy: false } : {}));
    const created = await h.engine.createJob(request(files));

    let engine = h.engine;
    let cycles = 0;
    for (; cycles < 400; cycles++) {
      const status = engine.getJob(created.id)?.status;
      if (status !== 'queued' && status !== 'running' && status !== 'verifying') break;
      if (cycles % 3 === 1) h.b.loseResponseNext('copyWithin');
      if (cycles % 5 === 2) h.b.loseResponseNext('resumableUploadFromStream');
      engine.start();
      const ticks = 8 + ((cycles * 7) % 23);
      for (let t = 0; t < ticks; t++) await tick();
      await engine.pause();
      if (cycles % 6 === 5) {
        // Host restart: the old instance is gone, a new one resumes from the database.
        await engine.close();
        engine = restartManual();
      }
    }

    const job = engine.getJob(created.id);
    expect(cycles).toBeGreaterThan(5); // it really was interrupted many times
    expect(job?.status).toBe('completed');
    expect(job?.items).toHaveLength(100);
    expect(job?.items?.every((i) => i.status === 'done' && i.verified === true)).toBe(true);
    const counts = namesBelow(h.b);
    expect(Object.keys(counts).sort()).toEqual(names);
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
    expect(h.drive.activePermissions()).toEqual([]);
    const failedEvents = h.events.filter((e) => e.type === 'item.updated' && e.payload.item.status === 'failed');
    expect(failedEvents).toEqual([]);
    expect(h.events.filter((e) => e.type === 'job.finished')).toHaveLength(1);
  });
});
