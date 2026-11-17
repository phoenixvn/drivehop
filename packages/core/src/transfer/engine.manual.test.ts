import { afterEach, describe, expect, it } from 'vitest';
import type { CreateTransferRequest } from '@multicloud/shared';
import { createHarness } from './testing/harness.ts';
import type { Harness } from './testing/harness.ts';
import type { TransferEngineHandle } from './index.ts';

// Manual mode is how the Cloudflare host runs the engine: work happens only between start() and
// pause(), and an interruption (pause, or the host disappearing) must never look like a failure.

let h: Harness;
const extraEngines: TransferEngineHandle[] = [];

afterEach(async () => {
  await h.engine.close();
  for (const engine of extraEngines.splice(0)) await engine.close();
  h.db.close();
});

function request(mode: 'copy' | 'move', ids: string[]): CreateTransferRequest {
  return {
    mode,
    sourceAccountId: 'acc-a',
    destAccountId: 'acc-b',
    destFolderId: 'root',
    sourceFileIds: ids,
    ...(mode === 'move' ? { confirmMove: true } : {}),
  };
}

const addFiles = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => h.a.addFile('root', `file-${i}.bin`, 100 + i));

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('manual mode', () => {
  it('queues a new job without running it until start()', async () => {
    h = createHarness({ manual: true });
    const files = addFiles(2);

    const created = await h.engine.createJob(request('copy', files));
    await tick();
    await tick();

    expect(created.status).toBe('queued');
    expect(h.engine.hasWork()).toBe(true);
    expect(h.drive.callsOf('shareWithAccount', 'copyWithin')).toEqual([]);

    h.engine.start();
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(h.engine.hasWork()).toBe(false);
    expect(h.b.tree()).toHaveLength(2);
  });

  it('pauses mid-job without failing anything, then finishes on the next start()', async () => {
    h = createHarness({ manual: true });
    const files = addFiles(6);
    const gate = h.b.gate('copyWithin');

    const created = await h.engine.createJob(request('copy', files));
    h.engine.start();
    await gate.waitForCalls(3);
    const pausing = h.engine.pause();
    gate.release();
    await pausing;

    const paused = h.engine.getJob(created.id);
    expect(paused?.status).toBe('queued');
    expect(paused?.finishedAt).toBeUndefined();
    expect(paused?.items?.filter((i) => i.status === 'done')).toHaveLength(3);
    expect(paused?.items?.filter((i) => i.status === 'pending')).toHaveLength(3);
    expect(paused?.items?.some((i) => i.status === 'failed' || i.error !== undefined)).toBe(false);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.events.some((e) => e.type === 'job.finished')).toBe(false);
    expect(h.engine.hasWork()).toBe(true);

    h.engine.start();
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(job.items?.every((i) => i.status === 'done' && i.verified === true)).toBe(true);
    // Every file was copied exactly once across the two runs.
    expect(h.drive.callsOf('copyWithin')).toHaveLength(6);
    expect(h.b.tree()).toHaveLength(6);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.events.filter((e) => e.type === 'job.finished')).toHaveLength(1);
  });

  it('resumes an unfinished job in a new engine and removes the permission it left behind', async () => {
    h = createHarness({ manual: true });
    const files = addFiles(4);

    const created = await h.engine.createJob(request('copy', files));
    // Simulate the host dying mid-copy: one item was running with its temporary permission live.
    const { permissionId } = await h.a.shareWithAccount(files[0] ?? '', 'b@example.com');
    h.db.prepare(`UPDATE transfer_jobs SET status = 'running' WHERE id = ?`).run(created.id);
    h.db
      .prepare(`INSERT INTO transfer_items (id, job_id, depth, source_id, name, status, permission_id, meta_loaded, can_copy, size_bytes)
                VALUES ('dead-item', ?, 0, ?, 'file-0.bin', 'running', ?, 0, 1, 100)`)
      .run(created.id, files[0] ?? '', permissionId);

    const next = h.restart({ manual: true });
    extraEngines.push(next);
    expect(next.getJob(created.id)?.status).toBe('queued');
    expect(next.hasWork()).toBe(true);

    next.start();
    const job = await next.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(h.drive.activePermissions()).toEqual([]);
    expect(job.items?.every((i) => i.status === 'done')).toBe(true);
  });

  it('resumes after a crash between a landed share create and recording its id, and removes that share', async () => {
    h = createHarness({ manual: true });
    const files = addFiles(2);

    const created = await h.engine.createJob(request('copy', files));
    // The host died right after the create was sent: the share exists, only share_pending was saved.
    await h.a.shareWithAccount(files[0] ?? '', 'b@example.com');
    h.db.prepare(`UPDATE transfer_jobs SET status = 'running' WHERE id = ?`).run(created.id);
    h.db
      .prepare(`INSERT INTO transfer_items (id, job_id, depth, source_id, name, status, share_pending, meta_loaded, can_copy, size_bytes)
                VALUES ('dead-item', ?, 0, ?, 'file-0.bin', 'running', 1, 0, 1, 100)`)
      .run(created.id, files[0] ?? '');

    const next = h.restart({ manual: true });
    extraEngines.push(next);
    next.start();
    const job = await next.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM transfer_items WHERE share_pending = 1').get()).toEqual({ n: 0 });
  });

  it('after the same kind of crash, keeps a share the owner made before (no share_pending mark)', async () => {
    h = createHarness({ manual: true });
    const files = addFiles(1);
    h.a.preShare(files[0] ?? '', 'b@example.com');

    const created = await h.engine.createJob(request('copy', files));
    h.db.prepare(`UPDATE transfer_jobs SET status = 'running' WHERE id = ?`).run(created.id);
    h.db
      .prepare(`INSERT INTO transfer_items (id, job_id, depth, source_id, name, status, meta_loaded, can_copy, size_bytes)
                VALUES ('dead-item', ?, 0, ?, 'file-0.bin', 'running', 0, 1, 100)`)
      .run(created.id, files[0] ?? '');

    const next = h.restart({ manual: true });
    extraEngines.push(next);
    next.start();
    const job = await next.waitForJob(created.id);
    await next.cleanupOrphanPermissions();

    expect(job.status).toBe('completed');
    expect(h.drive.activePermissions()).toEqual([`${files[0]}:b@example.com`]);
    expect(h.drive.callsOf('unshare')).toEqual([]);
  });

  it('never trashes sources of a move that was paused before everything verified', async () => {
    h = createHarness({ manual: true, itemConcurrency: 1 });
    const files = addFiles(3);
    const gate = h.b.gate('copyWithin');

    const created = await h.engine.createJob(request('move', files));
    h.engine.start();
    await gate.waitForCalls(1);
    const pausing = h.engine.pause();
    gate.release();
    await pausing;

    expect(h.drive.callsOf('trash')).toEqual([]);
    expect(h.engine.getJob(created.id)?.status).toBe('queued');

    h.engine.start();
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('completed');
    // Trash ran only in the final run, after all three copies existed.
    const calls = h.drive.callsOf('copyWithin', 'trash').map((c) => c.op);
    expect(calls).toEqual(['copyWithin', 'copyWithin', 'copyWithin', 'trash', 'trash', 'trash']);
  });

  it('cancels a queued job while the gate is closed', async () => {
    h = createHarness({ manual: true });
    const created = await h.engine.createJob(request('copy', addFiles(2)));

    const job = await h.engine.cancel(created.id);

    expect(job.status).toBe('canceled');
    expect(h.engine.hasWork()).toBe(false);
    expect(h.drive.callsOf('shareWithAccount')).toEqual([]);
  });
});
