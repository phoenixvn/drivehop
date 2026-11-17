import { afterEach, describe, expect, it } from 'vitest';
import { SHORTCUT_MIME_TYPE } from '@multicloud/shared';
import type { CreateTransferRequest } from '@multicloud/shared';
import { createHarness } from './testing/harness.ts';
import type { Harness } from './testing/harness.ts';
import { TransferError } from './index.ts';

let h: Harness;

afterEach(async () => {
  await h.engine.close();
  h.db.close();
});

function req(mode: 'copy' | 'move', ids: string[]): CreateTransferRequest {
  return {
    mode,
    ...(mode === 'move' ? { confirmMove: true } : {}),
    sourceAccountId: 'acc-a',
    destAccountId: 'acc-b',
    destFolderId: 'root',
    sourceFileIds: ids,
  };
}

async function run(request: CreateTransferRequest) {
  const created = await h.engine.createJob(request);
  return h.engine.waitForJob(created.id);
}

describe('shortcuts', () => {
  it('recreates a shortcut whose target is in the transfer so it points at the copy, never sharing it', async () => {
    h = createHarness();
    const folder = h.a.addFolder('root', 'Work');
    // The shortcut is listed BEFORE its target: it must still wait for the target's copy.
    const shortcut = h.a.addShortcut(folder, 'report.iso', 'placeholder');
    const target = h.a.addFile(folder, 'z-report.iso', 'iso-bytes');
    h.a.node(shortcut).shortcutTargetId = target;

    const job = await run(req('move', [folder]));

    expect(job.status).toBe('completed');
    const work = h.b.childrenOf('root')[0];
    if (work === undefined) throw new Error('no copy of Work');
    const copies = h.b.childrenOf(work.id);
    const copiedTarget = copies.find((n) => n.name === 'z-report.iso');
    const copiedShortcut = copies.find((n) => n.name === 'report.iso');
    expect(copiedShortcut?.mimeType).toBe(SHORTCUT_MIME_TYPE);
    expect(copiedShortcut?.shortcutTargetId).toBe(copiedTarget?.id);
    // A shortcut is never shared or copied with files.copy (that is what failed on real Drive).
    const shortcutTouches = h.drive.calls.filter(
      (c) => (c.op === 'shareWithAccount' || c.op === 'copyWithin') && c.target === shortcut,
    );
    expect(shortcutTouches).toEqual([]);
    expect(h.a.tree()).toEqual([]);
  });

  it('points at the same outside target when the destination can open it', async () => {
    h = createHarness();
    const outside = h.b.addFile('root', 'theirs.pdf', 'pdf');
    h.b.grantRead(outside, 'a@example.com');
    const shortcut = h.a.addShortcut('root', 'theirs.pdf', outside);

    const job = await run(req('copy', [shortcut]));

    expect(job.status).toBe('completed');
    const created = h.b.childrenOf('root').find((n) => n.mimeType === SHORTCUT_MIME_TYPE);
    expect(created?.shortcutTargetId).toBe(outside);
  });

  it('fails only the shortcut, with a clear code, when the destination cannot open the target', async () => {
    h = createHarness();
    const third = h.drive.addAccount('acc-c', 'c@example.com');
    const foreign = third.addFile('root', 'foreign.rar', 'rar');
    third.grantRead(foreign, 'a@example.com');
    const shortcut = h.a.addShortcut('root', 'foreign.rar', foreign);
    const file = h.a.addFile('root', 'ok.txt', 'ok');

    const job = await run(req('move', [shortcut, file]));

    expect(job.status).toBe('completed_with_errors');
    const items = job.items ?? [];
    expect(items.find((i) => i.sourceId === shortcut)?.error).toMatch(/^shortcut_target_unavailable: /);
    // The other selected item still moved; the shortcut stays at the source.
    expect(items.find((i) => i.sourceId === file)?.sourceTrashed).toBe(true);
    expect(h.a.childrenOf('root').map((n) => n.name)).toEqual(['foreign.rar']);
  });
});

describe('purgeTrashedSources', () => {
  it('deletes forever only the sources this move trashed, after checking each copy', async () => {
    h = createHarness();
    const folder = h.a.addFolder('root', 'Big');
    h.a.addFile(folder, 'a.bin', 50);
    const single = h.a.addFile('root', 'b.bin', 20);
    const unrelated = h.a.addFile('root', 'mine.txt', 'x');
    const job = await run(req('move', [folder, single]));
    expect(job.status).toBe('completed');
    expect(job.trash).toEqual({ trashed: 2, purged: 0 });
    // Something the user trashed themselves: never touched.
    await h.a.trash(unrelated);

    const result = await h.engine.purgeTrashedSources(job.id);

    expect(result).toMatchObject({ purged: 2, skipped: 0, failed: 0, remaining: 0 });
    expect(result.job.trash).toEqual({ trashed: 0, purged: 2 });
    expect(h.drive.nodes.has(folder)).toBe(false);
    expect(h.drive.nodes.has(single)).toBe(false);
    expect(h.drive.nodes.get(unrelated)?.trashed).toBe(true);
    expect(h.drive.callsOf('deleteTrashedForever').map((c) => c.target).sort()).toEqual([folder, single].sort());
    // The copies are untouched.
    expect(h.b.tree()).toEqual([
      { name: 'b.bin', size: 20 },
      { name: 'Big', children: [{ name: 'a.bin', size: 50 }] },
    ]);
  });

  it('skips an original the user restored and one whose copy is gone', async () => {
    h = createHarness();
    const restored = h.a.addFile('root', 'restored.bin', 10);
    const lostCopy = h.a.addFile('root', 'lost.bin', 10);
    const job = await run(req('move', [restored, lostCopy]));
    h.a.node(restored).trashed = false;
    const lost = (job.items ?? []).find((i) => i.sourceId === lostCopy);
    if (lost?.destId === undefined) throw new Error('no copy');
    await h.b.trash(lost.destId);

    const result = await h.engine.purgeTrashedSources(job.id);

    expect(result).toMatchObject({ purged: 0, skipped: 2, failed: 0, remaining: 0 });
    expect(h.drive.nodes.get(restored)?.trashed).toBe(false);
    expect(h.drive.nodes.get(lostCopy)?.trashed).toBe(true);
    expect(h.drive.callsOf('deleteTrashedForever').map((c) => c.target)).toEqual([restored]);
    const items = h.engine.getJob(job.id)?.items ?? [];
    expect(items.find((i) => i.sourceId === restored)?.sourceTrashed).toBeUndefined();
    expect(items.find((i) => i.sourceId === lostCopy)?.warning).toMatch(/^purge_skipped: /);
  });

  it('works in bounded batches and refuses copy jobs', async () => {
    h = createHarness();
    const ids = [1, 2, 3].map((n) => h.a.addFile('root', `f${n}.bin`, n));
    const job = await run(req('move', ids));

    const first = await h.engine.purgeTrashedSources(job.id, { maxItems: 2 });
    expect(first).toMatchObject({ purged: 2, remaining: 1 });
    const second = await h.engine.purgeTrashedSources(job.id, { maxItems: 2 });
    expect(second).toMatchObject({ purged: 1, remaining: 0 });

    const copy = await run(req('copy', [h.a.addFile('root', 'c.bin', 1)]));
    await expect(h.engine.purgeTrashedSources(copy.id)).rejects.toBeInstanceOf(TransferError);
  });
});

describe('large jobs', () => {
  it('copies more files than one page and returns a bounded item list', async () => {
    h = createHarness();
    h.drive.pageSize = 1000;
    const folder = h.a.addFolder('root', 'Many');
    for (let n = 0; n < 2050; n++) h.a.addFile(folder, `f${n}.txt`, 'x');
    const broken = h.a.addFile(folder, 'zz-broken.bin', 'y', { canCopy: false, canDownload: false });

    const job = await run(req('copy', [folder]));

    expect(job.status).toBe('completed_with_errors');
    expect(job.totals).toMatchObject({ items: 2052, done: 2051, failed: 1 });
    expect(job.items).toHaveLength(2000);
    expect(job.itemsOmitted).toBe(52);
    // The selected folder and the failure come first, whatever their position in the job.
    expect(job.items?.slice(0, 2).map((i) => i.sourceId)).toEqual([folder, broken]);
  });
});
