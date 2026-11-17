import { afterEach, describe, expect, it } from 'vitest';
import type { CreateTransferRequest, SseEvent } from '@multicloud/shared';
import { createHarness } from './testing/harness.ts';
import type { Harness } from './testing/harness.ts';
import { fakeError } from './testing/FakeProvider.ts';
import type { TransferEngineHandle, TransferEngineOptions } from './index.ts';

let h: Harness;
const extraEngines: TransferEngineHandle[] = [];
const setup = (options?: TransferEngineOptions): Harness => {
  h = createHarness(options);
  return h;
};

afterEach(async () => {
  await h.engine.close();
  for (const engine of extraEngines.splice(0)) await engine.close();
  h.db.close();
});

function copyAtoB(ids: string[], extra: Partial<CreateTransferRequest> = {}): CreateTransferRequest {
  return {
    mode: 'copy',
    sourceAccountId: 'acc-a',
    destAccountId: 'acc-b',
    destFolderId: 'root',
    sourceFileIds: ids,
    ...extra,
  };
}

function addFiles(count: number, options: { canCopy?: boolean } = {}): string[] {
  return Array.from({ length: count }, (_, i) => h.a.addFile('root', `file-${i}.bin`, 100 + i, options));
}

describe('cancel', () => {
  it('cleans up temporary permissions and marks unfinished items canceled', async () => {
    setup();
    const files = addFiles(6);
    const gate = h.a.gate('shareWithAccount');

    const created = await h.engine.createJob(copyAtoB(files));
    await gate.waitForCalls(3);
    const canceling = h.engine.cancel(created.id);
    gate.release();
    const job = await canceling;

    expect(job.status).toBe('canceled');
    expect(job.finishedAt).toBeDefined();
    expect(job.items?.map((i) => i.status)).toEqual(Array(6).fill('canceled'));
    expect(job.items?.every((i) => i.error === 'canceled')).toBe(true);
    // The three shares that were in flight were all undone; nothing was copied; nothing new started.
    expect(h.drive.callsOf('shareWithAccount')).toHaveLength(3);
    expect(h.drive.callsOf('unshare')).toHaveLength(3);
    expect(h.drive.callsOf('copyWithin')).toEqual([]);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.b.tree()).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ type: 'job.finished', payload: { job: { status: 'canceled' } } });
    expect(job.totals).toMatchObject({ items: 6, done: 0, failed: 0, bytesDone: 0 });
  });

  it('keeps copies that completed while canceling and still removes their permissions', async () => {
    setup();
    const files = addFiles(5);
    const gate = h.b.gate('copyWithin');

    const created = await h.engine.createJob(copyAtoB(files));
    await gate.waitForCalls(3);
    const canceling = h.engine.cancel(created.id);
    gate.release();
    const job = await canceling;

    expect(job.status).toBe('canceled');
    expect(job.items?.filter((i) => i.status === 'done')).toHaveLength(3);
    expect(job.items?.filter((i) => i.status === 'canceled')).toHaveLength(2);
    expect(h.drive.callsOf('copyWithin')).toHaveLength(3);
    expect(h.drive.callsOf('unshare')).toHaveLength(3);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.drive.callsOf('trash')).toEqual([]);
  });

  it('aborts a running stream upload', async () => {
    setup();
    const [file] = addFiles(1, { canCopy: false });
    const gate = h.b.gate('resumableUploadFromStream');

    const created = await h.engine.createJob(copyAtoB([file ?? '']));
    await gate.waitForCalls(1);
    const canceling = h.engine.cancel(created.id);
    gate.release();
    const job = await canceling;

    expect(job.status).toBe('canceled');
    expect(job.items?.[0]).toMatchObject({ status: 'canceled', error: 'canceled', bytesDone: 0 });
    expect(h.b.tree()).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });

  it('does not sleep through a backoff once canceled', async () => {
    let wake: () => void = () => {};
    const sleeping = new Promise<void>((resolve) => {
      wake = resolve;
    });
    let entered: () => void = () => {};
    const inSleep = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setup({
      sleep: async (_ms, signal) => {
        entered();
        signal?.addEventListener('abort', () => wake(), { once: true });
        await sleeping;
      },
    });
    const [file] = addFiles(1);
    h.b.failNext('copyWithin', () => fakeError('rate_limit', 429), 99);

    const created = await h.engine.createJob(copyAtoB([file ?? '']));
    await inSleep;
    const job = await h.engine.cancel(created.id);

    expect(job.status).toBe('canceled');
    expect(h.drive.callsOf('copyWithin')).toHaveLength(1);
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('cancels a queued job before it starts, and runs jobs one at a time', async () => {
    setup();
    const [first, second] = addFiles(2);
    const gate = h.b.gate('copyWithin');

    const jobOne = await h.engine.createJob(copyAtoB([first ?? '']));
    const jobTwo = await h.engine.createJob(copyAtoB([second ?? '']));
    await gate.waitForCalls(1);
    expect(h.engine.getJob(jobOne.id)?.status).toBe('running');
    expect(h.engine.getJob(jobTwo.id)?.status).toBe('queued');

    const canceled = await h.engine.cancel(jobTwo.id);
    expect(canceled.status).toBe('canceled');
    gate.release();
    await h.engine.whenIdle();

    expect(h.engine.getJob(jobOne.id)?.status).toBe('completed');
    expect(h.engine.getJob(jobTwo.id)?.status).toBe('canceled');
    expect(h.drive.calls.some((c) => c.target === second)).toBe(false);
    // Canceling a finished job is a no-op.
    expect((await h.engine.cancel(jobOne.id)).status).toBe('completed');
  });

  it('rejects unknown ids', async () => {
    setup();
    await expect(h.engine.cancel('nope')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    await expect(h.engine.retryFailed('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.engine.waitForJob('nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(h.engine.getJob('nope')).toBeUndefined();
  });
});

describe('retryFailed', () => {
  it('re-runs only failed and canceled items', async () => {
    setup({ itemConcurrency: 1 });
    const files = addFiles(4);
    const gate = h.b.gate('copyWithin', files[2]);
    h.b.failNext('copyWithin', fakeError('forbidden', 403), 1, files[1]);
    h.a.failNext('downloadStream', fakeError('forbidden', 403), 1, files[1]);

    const created = await h.engine.createJob(copyAtoB(files));
    await gate.waitForCalls(1);
    await expect(h.engine.retryFailed(created.id)).rejects.toMatchObject({ code: 'job_not_finished', httpStatus: 409 });
    const canceling = h.engine.cancel(created.id);
    gate.release();
    const first = await canceling;

    // file-0 done, file-1 failed, file-2 finished while canceling, file-3 never started.
    expect(first.status).toBe('canceled');
    expect(first.items?.map((i) => i.status)).toEqual(['done', 'failed', 'done', 'canceled']);
    expect(first.totals).toMatchObject({ items: 4, done: 2, failed: 1 });

    const requeued = await h.engine.retryFailed(created.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.items?.map((i) => i.status)).toEqual(['done', 'pending', 'done', 'pending']);
    const second = await h.engine.waitForJob(created.id);

    expect(second.status).toBe('completed');
    expect(second.items?.map((i) => i.status)).toEqual(['done', 'done', 'done', 'done']);
    const copies = (id: string | undefined): number => h.drive.callsOf('copyWithin').filter((c) => c.target === id).length;
    expect([copies(files[0]), copies(files[1]), copies(files[2]), copies(files[3])]).toEqual([1, 2, 1, 1]);
    expect(h.b.tree()).toHaveLength(4);
    expect(second.totals).toEqual({ items: 4, done: 4, failed: 0, bytesTotal: 406, bytesDone: 406 });
    expect(h.drive.activePermissions()).toEqual([]);

    // A fully completed job has nothing to retry.
    const calls = h.drive.calls.length;
    expect((await h.engine.retryFailed(created.id)).status).toBe('completed');
    await h.engine.whenIdle();
    expect(h.drive.calls).toHaveLength(calls);
  });

  it('re-lists a folder whose listing failed and reuses folders that already exist', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    const sub = h.a.addFolder(folder, 'Sub');
    h.a.addFile(sub, 'a.txt', 'a');
    h.a.addFile(folder, 'b.txt', 'b');
    h.a.failNext('listFolder', fakeError('forbidden', 403), 1, sub);

    const created = await h.engine.createJob(copyAtoB([folder]));
    const first = await h.engine.waitForJob(created.id);
    expect(first.status).toBe('completed_with_errors');
    expect(first.items?.find((i) => i.name === 'Sub')?.error).toMatch(/^forbidden/);
    expect(h.b.tree()).toEqual([{ name: 'Docs', children: [{ name: 'b.txt', size: 1 }] }]);

    await h.engine.retryFailed(created.id);
    const second = await h.engine.waitForJob(created.id);

    expect(second.status).toBe('completed');
    expect(h.b.tree()).toEqual([
      {
        name: 'Docs',
        children: [
          { name: 'b.txt', size: 1 },
          { name: 'Sub', children: [{ name: 'a.txt', size: 1 }] },
        ],
      },
    ]);
    expect(h.drive.callsOf('createFolder')).toHaveLength(2);
    expect(second.items?.every((i) => i.status === 'done' && i.verified === true)).toBe(true);
  });
});

describe('persistence and restart', () => {
  it('keeps finished jobs as history for a new engine on the same database', async () => {
    setup();
    const [file] = addFiles(1);
    const created = await h.engine.createJob(copyAtoB([file ?? '']));
    const done = await h.engine.waitForJob(created.id);
    await h.engine.close();

    const engine = h.restart();
    extraEngines.push(engine);

    expect(engine.listJobs()).toEqual([{ ...done, items: undefined }].map(({ items: _items, ...job }) => job));
    expect(engine.getJob(created.id)).toEqual(done);
  });

  it('marks jobs that were in flight as failed/interrupted and lets them be retried', async () => {
    setup();
    const files = addFiles(3);
    h.b.failNext('copyWithin', fakeError('forbidden', 403), 1, files[1]);
    h.a.failNext('downloadStream', fakeError('forbidden', 403), 1, files[1]);
    const created = await h.engine.createJob(copyAtoB(files));
    await h.engine.waitForJob(created.id);
    await h.engine.close();

    // Rewind the database to what a crash in the middle of the run leaves behind.
    h.db.prepare(`UPDATE transfer_jobs SET status = 'running', finished_at = NULL, error = NULL`).run();
    h.db
      .prepare(`UPDATE transfer_items SET status = 'running', error = NULL, bytes_done = 7 WHERE source_id = ?`)
      .run(files[1]);
    h.db
      .prepare(`UPDATE transfer_items SET status = 'pending', dest_id = NULL, verified = NULL WHERE source_id = ?`)
      .run(files[2]);
    const copyOfThird = h.b.childrenOf('root').find((n) => n.name === 'file-2.bin');
    if (copyOfThird) copyOfThird.trashed = true;
    h.db
      .prepare(
        `INSERT INTO transfer_jobs (id, mode, source_account_id, dest_account_id, dest_folder_id, source_file_ids, confirm_move, status, created_at)
         VALUES ('queued-job', 'copy', 'acc-a', 'acc-b', 'root', ?, 0, 'queued', '2020-01-01T00:00:00.000Z')`,
      )
      .run(JSON.stringify([files[0]]));
    const callsBefore = h.drive.calls.length;

    const engine = h.restart();
    extraEngines.push(engine);

    // Nothing runs on its own after a restart.
    await engine.whenIdle();
    expect(h.drive.calls).toHaveLength(callsBefore);
    const recovered = engine.getJob(created.id);
    expect(recovered).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(recovered?.finishedAt).toBeDefined();
    expect(recovered?.items?.map((i) => [i.status, i.error])).toEqual([
      ['done', undefined],
      ['failed', 'interrupted'],
      ['failed', 'interrupted'],
    ]);
    expect(recovered?.totals).toMatchObject({ items: 3, done: 1, failed: 2, bytesDone: 100 });
    expect(engine.getJob('queued-job')).toMatchObject({ status: 'failed', error: 'interrupted', items: [] });
    expect(engine.listJobs().map((j) => j.id)).toEqual([created.id, 'queued-job']);

    await engine.retryFailed(created.id);
    const retried = await engine.waitForJob(created.id);
    expect(retried.status).toBe('completed');
    expect(retried.error).toBeUndefined();
    expect(h.drive.callsOf('copyWithin').filter((c) => c.target === files[0])).toHaveLength(1);
    expect(h.b.tree()).toHaveLength(3);

    // A job that was still queued (never planned) can be retried as well.
    await engine.retryFailed('queued-job');
    expect((await engine.waitForJob('queued-job')).status).toBe('completed');
    expect(h.b.tree()).toHaveLength(4);
  });

  it('close() interrupts a running job, cleans up its permission, and leaves it retryable', async () => {
    setup();
    const files = addFiles(2);
    const gate = h.b.gate('copyWithin', files[0]);
    const created = await h.engine.createJob(copyAtoB(files, { mode: 'move', confirmMove: true }));
    await gate.waitForCalls(1);
    h.b.failNext('copyWithin', fakeError('server', 500), 1, files[0]);

    const closing = h.engine.close();
    gate.release();
    await closing;

    const job = h.engine.getJob(created.id);
    expect(job).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(job?.items?.some((i) => i.error === 'interrupted')).toBe(true);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.drive.callsOf('trash')).toEqual([]);
    await expect(h.engine.createJob(copyAtoB(files))).rejects.toMatchObject({ code: 'engine_closed' });

    const engine = h.restart();
    extraEngines.push(engine);
    await engine.retryFailed(created.id);
    const retried = await engine.waitForJob(created.id);
    expect(retried.status).toBe('completed');
    expect(h.drive.callsOf('trash').map((c) => c.target)).toEqual(files);
  });
});

describe('leftover temporary permissions', () => {
  const pending = (): Array<{ source_id: string; permission_id: string | null }> =>
    h.db.prepare('SELECT source_id, permission_id FROM transfer_items WHERE permission_id IS NOT NULL').all() as Array<{
      source_id: string;
      permission_id: string | null;
    }>;

  /** A finished job plus a reader permission that a crashed process never removed. */
  async function leaveOrphan(): Promise<{ file: string; permissionId: string }> {
    const [file = ''] = addFiles(1);
    const created = await h.engine.createJob(copyAtoB([file]));
    await h.engine.waitForJob(created.id);
    await h.engine.close();
    const { permissionId } = await h.a.shareWithAccount(file, 'b@example.com');
    h.db.prepare('UPDATE transfer_items SET permission_id = ? WHERE source_id = ?').run(permissionId, file);
    expect(h.drive.activePermissions()).toHaveLength(1);
    return { file, permissionId };
  }

  it('removes them when the engine starts again after a crash', async () => {
    setup();
    await leaveOrphan();

    const engine = h.restart();
    extraEngines.push(engine);
    await engine.cleanupOrphanPermissions();

    expect(h.drive.activePermissions()).toEqual([]);
    expect(pending()).toEqual([]);
    expect(h.drive.callsOf('trash')).toEqual([]);
  });

  it('keeps the record and retries at the next start when Google refuses', async () => {
    setup();
    const { file } = await leaveOrphan();
    h.a.failNext('unshare', fakeError('forbidden', 403), 1, file);

    const engine = h.restart();
    extraEngines.push(engine);
    expect(await engine.cleanupOrphanPermissions()).toBe(0);
    expect(h.drive.activePermissions()).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('leftover temporary permission'))).toBe(true);

    const next = h.restart();
    extraEngines.push(next);
    expect(await next.cleanupOrphanPermissions()).toBe(1);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(pending()).toEqual([]);
  });

  const sharePending = (): number[] =>
    (h.db.prepare('SELECT share_pending FROM transfer_items WHERE is_folder = 0').all() as Array<{ share_pending: number }>).map(
      (r) => r.share_pending,
    );

  it('removes a share whose create landed but whose response was lost (retried within the run)', async () => {
    setup();
    const [file = ''] = addFiles(1);
    h.a.loseResponseNext('shareWithAccount', () => fakeError('server', 503), 1, file);

    const job = await h.engine.waitForJob((await h.engine.createJob(copyAtoB([file]))).id);

    expect(job.status).toBe('completed');
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.drive.callsOf('unshare')).toHaveLength(1);
    expect(sharePending()).toEqual([0]);
  });

  it('removes such a share in the same run when the share call fails for good after its create landed', async () => {
    setup();
    const [file = ''] = addFiles(1);
    // The create lands, then the call fails for good: the item falls back to streaming.
    h.a.loseResponseNext('shareWithAccount', () => fakeError('forbidden', 403), 1, file);
    const job = await h.engine.waitForJob((await h.engine.createJob(copyAtoB([file]))).id);

    expect(job.status).toBe('completed');
    expect(job.items?.[0]?.strategyUsed).toBe('stream');
    expect(h.drive.activePermissions()).toEqual([]);
    expect(sharePending()).toEqual([0]);
  });

  it('the sweep removes an unrecorded share left by a run that stopped (job finished or canceled)', async () => {
    setup();
    const [file = ''] = addFiles(1);
    await h.engine.waitForJob((await h.engine.createJob(copyAtoB([file]))).id);
    await h.engine.close();
    // A crash right after the create was sent: the share exists, only the mark was persisted.
    await h.a.shareWithAccount(file, 'b@example.com');
    h.db.prepare('UPDATE transfer_items SET share_pending = 1 WHERE source_id = ?').run(file);

    const engine = h.restart();
    extraEngines.push(engine);
    expect(await engine.cleanupOrphanPermissions()).toBe(1);

    expect(h.drive.activePermissions()).toEqual([]);
    expect(sharePending()).toEqual([0]);
    expect(pending()).toEqual([]);
  });

  it('keeps a share the owner made before, even when an attempt failed during the lookup', async () => {
    setup();
    const [file = ''] = addFiles(1);
    h.a.preShare(file, 'b@example.com');
    // The share call fails before anything is created (e.g. interrupted while listing).
    h.a.failNext('shareWithAccount', fakeError('forbidden', 403), 1, file);
    const job = await h.engine.waitForJob((await h.engine.createJob(copyAtoB([file]))).id);
    expect(sharePending()).toEqual([0]);
    await h.engine.close();
    const engine = h.restart();
    extraEngines.push(engine);
    await engine.cleanupOrphanPermissions();

    expect(job.status).toBe('completed');
    expect(h.drive.activePermissions()).toEqual([`${file}:b@example.com`]);
    expect(h.drive.callsOf('unshare')).toEqual([]);
  });

  it('clears the mark when Google rejected the create, so a share the owner makes LATER is never taken for ours', async () => {
    setup();
    const [file = ''] = addFiles(1);
    // The hook fires (lookup found nothing), then the create itself is answered with a 403: it cannot have landed.
    const real = h.a.shareWithAccount.bind(h.a);
    h.a.shareWithAccount = async (_fileId, _email, options) => {
      options?.beforeCreate?.();
      throw fakeError('forbidden', 403);
    };
    const job = await h.engine.waitForJob((await h.engine.createJob(copyAtoB([file]))).id);
    expect(job.status).toBe('completed');
    expect(job.items?.[0]?.strategyUsed).toBe('stream');
    expect(sharePending()).toEqual([0]);
    await h.engine.close();

    // Later the owner shares the file with the destination account by hand.
    h.a.shareWithAccount = real;
    h.a.preShare(file, 'b@example.com');
    const engine = h.restart();
    extraEngines.push(engine);
    await engine.cleanupOrphanPermissions();
    await engine.cleanupOrphanPermissions();

    expect(h.drive.activePermissions()).toEqual([`${file}:b@example.com`]);
    expect(h.drive.callsOf('unshare')).toEqual([]);
  });

  it('keeps the mark when the create outcome is unknown (5xx) so the sweep can settle it', async () => {
    setup();
    const [file = ''] = addFiles(1);
    h.a.shareWithAccount = async (_fileId, _email, options) => {
      options?.beforeCreate?.();
      throw fakeError('server', 503);
    };
    await h.engine.waitForJob((await h.engine.createJob(copyAtoB([file]))).id);
    expect(sharePending()).toEqual([1]);
  });

  it('treats a permission that is already gone as removed', async () => {
    setup();
    const { permissionId } = await leaveOrphan();
    h.db.prepare('UPDATE transfer_items SET permission_id = ?').run(`${permissionId}-gone`);

    const engine = h.restart();
    extraEngines.push(engine);
    await engine.cleanupOrphanPermissions();
    expect(pending()).toEqual([]);
  });
});

describe('events and totals', () => {
  it('emits job.created, updates, and job.finished in order with current totals', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 42);

    const created = await h.engine.createJob(copyAtoB([file]));
    expect(created).toMatchObject({
      mode: 'copy',
      status: 'queued',
      sourceAccountId: 'acc-a',
      destAccountId: 'acc-b',
      destFolderId: 'root',
      items: [],
      totals: { items: 0, done: 0, failed: 0, bytesTotal: 0, bytesDone: 0 },
    });
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    const job = await h.engine.waitForJob(created.id);

    expect(h.events[0]).toMatchObject({ type: 'job.created', payload: { job: { id: created.id, status: 'queued' } } });
    expect(h.events.at(-1)).toMatchObject({
      type: 'job.finished',
      payload: { job: { id: created.id, status: 'completed', totals: job.totals } },
    });
    expect(h.events.filter((e) => e.type === 'job.created')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'job.finished')).toHaveLength(1);

    const compact = (events: SseEvent[]): string[] => {
      const out: string[] = [];
      for (const event of events) {
        const label =
          event.type === 'item.updated'
            ? `item:${event.payload.item.status}`
            : `${event.type}:${event.payload.job.status}`;
        if (out.at(-1) !== label) out.push(label);
      }
      return out;
    };
    expect(compact(h.events)).toEqual([
      'job.created:queued',
      'job.updated:running',
      'item:pending',
      'job.updated:running',
      'item:pending',
      'job.updated:running',
      'item:running',
      'job.updated:running',
      'item:done',
      'job.updated:running',
      'job.updated:verifying',
      'job.finished:completed',
    ]);

    // Events never carry the item list; getJob does.
    for (const event of h.events) {
      if (event.type !== 'item.updated') expect(event.payload.job.items).toBeUndefined();
      else expect(event.payload.jobId).toBe(created.id);
    }
    expect(job.totals).toEqual({ items: 1, done: 1, failed: 0, bytesTotal: 42, bytesDone: 42 });
    expect(job.finishedAt).toBeDefined();

    // Totals in the stream are monotonic and end at the final value.
    const doneCounts = h.events.flatMap((e) => (e.type === 'item.updated' ? [] : [e.payload.job.totals.done]));
    expect(doneCounts).toEqual([...doneCounts].sort((x, y) => x - y));
  });

  it('keeps totals current for mixed outcomes', async () => {
    setup();
    const ok = h.a.addFile('root', 'ok.bin', 10);
    const doc = h.a.addGoogleDoc('root', 'Notes', { canCopy: false });
    const folder = h.a.addFolder('root', 'Docs');
    h.a.addFile(folder, 'in.bin', 5);

    const created = await h.engine.createJob(copyAtoB([ok, doc, folder]));
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('completed_with_errors');
    expect(job.totals).toEqual({ items: 4, done: 3, failed: 1, bytesTotal: 15, bytesDone: 15 });
    expect(h.engine.listJobs()[0]?.totals).toEqual(job.totals);
  });

  it('lists jobs newest first without items, and isolates listener errors', async () => {
    setup({ now: () => 1_700_000_000_000 });
    const [one, two] = addFiles(2);
    const seen: string[] = [];
    h.engine.subscribe(() => {
      throw new Error('listener bug');
    });
    const unsubscribe = h.engine.subscribe((event) => seen.push(event.type));

    const first = await h.engine.createJob(copyAtoB([one ?? '']));
    await h.engine.waitForJob(first.id);
    unsubscribe();
    const countAfterFirst = seen.length;
    const second = await h.engine.createJob(copyAtoB([two ?? '']));
    await h.engine.waitForJob(second.id);

    expect(seen.length).toBe(countAfterFirst);
    expect(seen[0]).toBe('job.created');
    expect(h.engine.getJob(first.id)?.status).toBe('completed');
    // Same createdAt (fixed clock): insertion order breaks the tie.
    expect(h.engine.listJobs().map((j) => j.id)).toEqual([second.id, first.id]);
    expect(h.engine.listJobs().every((j) => j.items === undefined)).toBe(true);
    expect(h.engine.getJob(second.id)?.items).toHaveLength(1);
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('listener'))).toBe(true);
  });

  it('fails the job when the provider cannot be resolved', async () => {
    setup();
    const created = await h.engine.createJob(copyAtoB(['x'], { sourceAccountId: 'acc-missing' }));
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^auth/);
    expect(job.items).toEqual([]);
  });
});
