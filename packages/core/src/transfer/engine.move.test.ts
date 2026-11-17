import { afterEach, describe, expect, it } from 'vitest';
import type { CreateTransferRequest, TransferJobStatus } from '@multicloud/shared';
import { createHarness } from './testing/harness.ts';
import type { Harness } from './testing/harness.ts';
import { fakeError } from './testing/FakeProvider.ts';
import { TransferError } from './index.ts';
import type { TransferEngineOptions } from './index.ts';

let h: Harness;
const setup = (options?: TransferEngineOptions): Harness => {
  h = createHarness(options);
  return h;
};

afterEach(async () => {
  await h.engine.close();
  h.db.close();
});

function moveAtoB(ids: string[], extra: Partial<CreateTransferRequest> = {}): CreateTransferRequest {
  return {
    mode: 'move',
    confirmMove: true,
    sourceAccountId: 'acc-a',
    destAccountId: 'acc-b',
    destFolderId: 'root',
    sourceFileIds: ids,
    ...extra,
  };
}

async function run(req: CreateTransferRequest) {
  const created = await h.engine.createJob(req);
  return h.engine.waitForJob(created.id);
}

function jobStatuses(): TransferJobStatus[] {
  const statuses: TransferJobStatus[] = [];
  for (const event of h.events) {
    if (event.type === 'item.updated') continue;
    const status = event.payload.job.status;
    if (statuses.at(-1) !== status) statuses.push(status);
  }
  return statuses;
}

describe('move', () => {
  it('copies, verifies, and only then trashes the selected top-level sources', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    h.a.addFile(folder, 'a.txt', 'aaa');
    h.a.addFile(folder, 'b.txt', 'bbbb');
    const sub = h.a.addFolder(folder, 'Sub');
    h.a.addFile(sub, 'c.txt', 'c');
    const single = h.a.addFile('root', 'single.bin', 100);
    const before = h.a.tree(folder);

    const job = await run(moveAtoB([folder, single]));

    expect(job.status).toBe('completed');
    expect(job.error).toBeUndefined();
    expect(jobStatuses()).toEqual(['queued', 'running', 'verifying', 'completed']);

    // Only the two selected sources are trashed, never their children, and trash comes last.
    const trashCalls = h.drive.callsOf('trash');
    expect(trashCalls.map((c) => `${c.accountId}:${c.target}`)).toEqual([`acc-a:${folder}`, `acc-a:${single}`]);
    const firstTrash = Math.min(...trashCalls.map((c) => c.seq));
    const others = h.drive.calls.filter((c) => c.op !== 'trash');
    expect(Math.max(...others.map((c) => c.seq))).toBeLessThan(firstTrash);

    // Verification listed both sides of every folder after the last copy.
    const lastCopy = Math.max(...h.drive.callsOf('copyWithin').map((c) => c.seq));
    const verifyLists = h.drive.callsOf('listFolder').filter((c) => c.seq > lastCopy);
    expect(new Set(verifyLists.map((c) => c.accountId))).toEqual(new Set(['acc-a', 'acc-b']));

    expect(h.a.tree()).toEqual([]);
    expect(h.b.tree()).toEqual([
      { name: 'Docs', children: before },
      { name: 'single.bin', size: 100 },
    ]);
    expect(job.items?.every((i) => i.status === 'done' && i.verified === true)).toBe(true);
    expect(job.items?.filter((i) => i.sourceTrashed).map((i) => i.sourceId)).toEqual([folder, single]);
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('keeps a file that failed verification and trashes only the selected items that verified', async () => {
    setup({ itemConcurrency: 1 });
    const one = h.a.addFile('root', 'one.bin', 50);
    const two = h.a.addFile('root', 'two.bin', 60);
    h.b.corruptNextWrites = 1;

    const job = await run(moveAtoB([one, two]));

    expect(job.status).toBe('completed_with_errors');
    expect(job.error).toMatch(/^move_not_verified: 1 of 2 selected items/);
    // Only the fully verified source went to the trash; the failed one stays where it was.
    expect(h.drive.callsOf('trash').map((c) => c.target)).toEqual([two]);
    expect(job.items?.find((i) => i.sourceId === one)).toMatchObject({ status: 'failed', verified: false });
    expect(job.items?.find((i) => i.sourceId === one)?.error).toMatch(/^verification_failed/);
    expect(job.items?.find((i) => i.sourceId === one)?.sourceTrashed).toBeUndefined();
    expect(job.items?.find((i) => i.sourceId === two)).toMatchObject({ status: 'done', verified: true, sourceTrashed: true });
    expect(h.a.tree()).toEqual([{ name: 'one.bin', size: 50 }]);
  });

  it('does NOT trash when a folder gained a child that was not copied', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    h.a.addFile(folder, 'a.txt', 'aaa');
    const gate = h.b.gate('createFolder');

    const created = await h.engine.createJob(moveAtoB([folder]));
    await gate.waitForCalls(1);
    h.a.addFile(folder, 'late.txt', 'added after planning');
    gate.release();
    const job = await h.engine.waitForJob(created.id);

    expect(job.status).toBe('completed_with_errors');
    expect(job.error).toMatch(/^move_not_verified/);
    const folderItem = job.items?.find((i) => i.isFolder);
    expect(folderItem).toMatchObject({ status: 'failed', verified: false });
    expect(folderItem?.error).toMatch(/^verification_failed: source folder has 2 children, 1 of 1/);
    expect(h.drive.callsOf('trash')).toEqual([]);
    expect(h.a.tree(folder)).toHaveLength(2);
  });

  it('does NOT trash when any item failed to copy', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    h.a.addFile(folder, 'a.txt', 'aaa');
    h.a.addGoogleDoc(folder, 'Notes', { canCopy: false });

    const job = await run(moveAtoB([folder]));

    expect(job.status).toBe('completed_with_errors');
    expect(job.error).toMatch(/^move_not_verified: 1 of 1 selected items \(2 items in total\)/);
    expect(h.drive.callsOf('trash')).toEqual([]);
    const folderItem = job.items?.find((i) => i.isFolder);
    // The folder itself was created; the failing child carries the reason.
    expect(folderItem).toMatchObject({ status: 'done', verified: false });
    expect(folderItem?.error).toBeUndefined();
    expect(h.a.tree(folder)).toHaveLength(2);
  });

  it('keeps a folder whose child failed, but trashes the other selected items that fully verified', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    h.a.addFile(folder, 'a.txt', 'aaa');
    h.a.addGoogleDoc(folder, 'Notes', { canCopy: false });
    const loose = h.a.addFile('root', 'loose.bin', 20);
    const other = h.a.addFolder('root', 'Photos');
    h.a.addFile(other, 'p.jpg', 'jpeg');

    const job = await run(moveAtoB([folder, loose, other]));

    expect(job.status).toBe('completed_with_errors');
    expect(job.error).toMatch(/^move_not_verified: 1 of 3 selected items/);
    // The folder with the uncopyable doc stays complete at the source, including its copied file.
    expect(h.drive.callsOf('trash').map((c) => c.target).sort()).toEqual([loose, other].sort());
    expect(h.a.tree()).toEqual([{ name: 'Docs', children: [{ name: 'a.txt', size: 3 }, { name: 'Notes', size: 0 }] }]);
    // Trash happens only after every copy of the run.
    const ops = h.drive.sequence('copyWithin', 'resumableUploadFromStream', 'trash');
    expect(ops.lastIndexOf('acc-b:copyWithin')).toBeLessThan(ops.indexOf('acc-a:trash'));
  });

  it('rejects a move without confirmMove === true and persists nothing', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10);

    for (const confirmMove of [undefined, false, 'true' as unknown as boolean]) {
      const attempt = h.engine.createJob(moveAtoB([file], { confirmMove }));
      await expect(attempt).rejects.toBeInstanceOf(TransferError);
      await expect(attempt).rejects.toMatchObject({ code: 'move_not_confirmed', httpStatus: 400 });
    }
    expect(h.engine.listJobs()).toEqual([]);
    expect(h.drive.calls).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('rejects other invalid requests with bad_request', async () => {
    setup();
    await expect(h.engine.createJob(moveAtoB([]))).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      h.engine.createJob({ ...moveAtoB(['x']), mode: 'delete' as unknown as 'move' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(h.engine.createJob(moveAtoB(['x'], { destFolderId: '' }))).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects a move into the folder the source already is in (same account)', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    const inRoot = h.a.addFile('root', 'a.bin', 10);
    const inFolder = h.a.addFile(folder, 'b.bin', 10);
    const sameAccount = { destAccountId: 'acc-a' };

    await expect(h.engine.createJob(moveAtoB([inRoot], { ...sameAccount, destFolderId: 'root' }))).rejects.toMatchObject({
      code: 'same_folder_move',
    });
    await expect(
      h.engine.createJob(moveAtoB([inRoot], { ...sameAccount, destFolderId: h.a.rootId })),
    ).rejects.toMatchObject({ code: 'same_folder_move' });
    await expect(
      h.engine.createJob(moveAtoB([inFolder], { ...sameAccount, destFolderId: folder })),
    ).rejects.toMatchObject({ code: 'same_folder_move' });
    expect(h.engine.listJobs()).toEqual([]);
    expect(h.drive.callsOf('trash', 'copyWithin')).toEqual([]);
  });

  it('rejects a destination inside the selected folder (same account)', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    const sub = h.a.addFolder(folder, 'Sub');
    const sameAccount = { destAccountId: 'acc-a' };

    await expect(h.engine.createJob(moveAtoB([folder], { ...sameAccount, destFolderId: sub }))).rejects.toMatchObject({
      code: 'dest_inside_source',
    });
    await expect(
      h.engine.createJob(moveAtoB([folder], { ...sameAccount, destFolderId: folder, mode: 'copy' })),
    ).rejects.toMatchObject({ code: 'dest_inside_source' });
  });

  it('moves within one account into another folder', async () => {
    setup();
    const target = h.a.addFolder('root', 'Target');
    const file = h.a.addFile('root', 'a.bin', 10);

    const job = await run(moveAtoB([file], { destAccountId: 'acc-a', destFolderId: target }));

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('shareWithAccount')).toEqual([]);
    expect(h.drive.callsOf('trash').map((c) => c.target)).toEqual([file]);
    expect(h.a.tree()).toEqual([{ name: 'Target', children: [{ name: 'a.bin', size: 10 }] }]);
  });

  it('retryFailed re-copies only the failed item, verifies again and then trashes', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    const good = h.a.addFile(folder, 'good.txt', 'good');
    const bad = h.a.addFile(folder, 'bad.txt', 'bad!', { canDownload: false });
    h.b.failNext('copyWithin', fakeError('forbidden', 403), 1, bad);

    const first = await run(moveAtoB([folder]));
    expect(first.status).toBe('completed_with_errors');
    expect(first.error).toMatch(/^move_not_verified/);
    expect(h.drive.callsOf('trash')).toEqual([]);

    const requeued = await h.engine.retryFailed(first.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.finishedAt).toBeUndefined();
    const second = await h.engine.waitForJob(first.id);

    expect(second.status).toBe('completed');
    expect(second.error).toBeUndefined();
    expect(h.drive.callsOf('copyWithin').filter((c) => c.target === good)).toHaveLength(1);
    expect(h.drive.callsOf('copyWithin').filter((c) => c.target === bad)).toHaveLength(2);
    expect(h.drive.callsOf('createFolder')).toHaveLength(1);
    expect(h.drive.callsOf('trash').map((c) => c.target)).toEqual([folder]);
    expect(second.items?.every((i) => i.status === 'done' && i.verified === true)).toBe(true);
    expect(h.b.tree()).toEqual([
      {
        name: 'Docs',
        children: [
          { name: 'bad.txt', size: 4 },
          { name: 'good.txt', size: 4 },
        ],
      },
    ]);
    expect(h.a.tree()).toEqual([]);
  });

  it('reports a failing trash and finishes it on retryFailed without copying again', async () => {
    setup();
    const one = h.a.addFile('root', 'one.bin', 10);
    const two = h.a.addFile('root', 'two.bin', 20);
    h.a.failNext('trash', fakeError('forbidden', 403), 1, two);

    const first = await run(moveAtoB([one, two]));

    expect(first.status).toBe('completed_with_errors');
    expect(first.error).toMatch(/^trash_failed: 1 of 2/);
    const failed = first.items?.find((i) => i.sourceId === two);
    expect(failed).toMatchObject({ status: 'done', verified: true });
    expect(failed?.warning).toMatch(/^trash_failed: /);
    expect(first.items?.find((i) => i.sourceId === one)?.sourceTrashed).toBe(true);

    await h.engine.retryFailed(first.id);
    const second = await h.engine.waitForJob(first.id);

    expect(second.status).toBe('completed');
    expect(h.drive.callsOf('copyWithin')).toHaveLength(2);
    expect(h.drive.callsOf('trash').map((c) => c.target)).toEqual([one, two, two]);
    expect(second.items?.every((i) => i.sourceTrashed === true && i.warning === undefined)).toBe(true);
    expect(h.a.tree()).toEqual([]);
  });
});
