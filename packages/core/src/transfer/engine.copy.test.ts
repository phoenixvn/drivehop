import { afterEach, describe, expect, it } from 'vitest';
import type { CreateTransferRequest } from '@multicloud/shared';
import { createHarness } from './testing/harness.ts';
import type { Harness } from './testing/harness.ts';
import { fakeError } from './testing/FakeProvider.ts';
import type { TransferEngineOptions } from './index.ts';

const MIB = 1024 * 1024;

let h: Harness;
const setup = (options?: TransferEngineOptions): Harness => {
  h = createHarness(options);
  return h;
};

afterEach(async () => {
  await h.engine.close();
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

async function run(req: CreateTransferRequest) {
  const created = await h.engine.createJob(req);
  return h.engine.waitForJob(created.id);
}

describe('permission-copy (primary strategy)', () => {
  it('shares, copies server-side, then removes the temporary permission', async () => {
    setup();
    const file = h.a.addFile('root', 'report.pdf', 'hello world');

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('completed');
    expect(h.drive.sequence('shareWithAccount', 'copyWithin', 'unshare')).toEqual([
      'acc-a:shareWithAccount',
      'acc-b:copyWithin',
      'acc-a:unshare',
    ]);
    expect(h.drive.callsOf('shareWithAccount')[0]?.args).toEqual([file, 'b@example.com']);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(h.drive.callsOf('downloadStream', 'resumableUploadFromStream', 'trash')).toEqual([]);
    expect(h.b.tree()).toEqual([{ name: 'report.pdf', size: 11 }]);

    const item = job.items?.[0];
    expect(item).toMatchObject({
      sourceId: file,
      name: 'report.pdf',
      isFolder: false,
      sizeBytes: 11,
      status: 'done',
      strategyUsed: 'permission-copy',
      verified: true,
    });
    expect(item?.error).toBeUndefined();
    expect(item?.destId).toBe(h.b.childrenOf('root')[0]?.id);
  });

  it('leaves a share the owner made earlier in place, on success and on failure', async () => {
    setup({ itemConcurrency: 1 });
    const failing = h.a.addGoogleDoc('root', 'Shared notes');
    const ok = h.a.addFile('root', 'shared.pdf', 'hello world');
    h.a.preShare(ok, 'b@example.com');
    h.a.preShare(failing, 'b@example.com');
    h.b.failNext('copyWithin', fakeError('forbidden', 403));

    const job = await run(copyAtoB([failing, ok]));

    expect(job.items?.map((i) => i.status).sort()).toEqual(['done', 'failed']);
    expect(h.drive.callsOf('unshare')).toEqual([]);
    expect(h.drive.activePermissions().sort()).toEqual([`${failing}:b@example.com`, `${ok}:b@example.com`].sort());
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM transfer_items WHERE permission_id IS NOT NULL').get()).toEqual({
      n: 0,
    });
  });

  it('removes the permission when the copy fails, then falls back to stream', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 1000);
    h.b.failNext('copyWithin', fakeError('forbidden', 403));

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('completed');
    expect(h.drive.sequence('shareWithAccount', 'copyWithin', 'unshare', 'downloadStream', 'resumableUploadFromStream')).toEqual([
      'acc-a:shareWithAccount',
      'acc-b:copyWithin',
      'acc-a:unshare',
      'acc-a:downloadStream',
      'acc-b:resumableUploadFromStream',
    ]);
    expect(h.drive.activePermissions()).toEqual([]);
    expect(job.items?.[0]).toMatchObject({ status: 'done', strategyUsed: 'stream', verified: true });
    expect(h.b.tree()).toEqual([{ name: 'a.bin', size: 1000 }]);
  });

  it('records a failing unshare as a warning without hiding the successful copy', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10);
    h.a.failNext('unshare', fakeError('forbidden', 403));

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('completed');
    const item = job.items?.[0];
    expect(item).toMatchObject({ status: 'done', strategyUsed: 'permission-copy', verified: true });
    expect(item?.error).toBeUndefined();
    expect(item?.warning).toMatch(/^unshare_failed: /);
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('temporary permission'))).toBe(true);
  });

  it('keeps the original failure when both the copy and the unshare fail', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10, { canDownload: false });
    h.b.failNext('copyWithin', fakeError('not_found', 404));
    h.a.failNext('unshare', fakeError('forbidden', 403));

    const job = await run(copyAtoB([file]));

    const item = job.items?.[0];
    expect(item?.status).toBe('failed');
    expect(item?.error).toMatch(/^forbidden: .*not_found/);
    expect(item?.warning).toMatch(/^unshare_failed: /);
    expect(job.status).toBe('failed');
  });

  it('copies within one account directly, without sharing', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Target');
    const file = h.a.addFile('root', 'a.bin', 10);

    const job = await run(copyAtoB([file], { destAccountId: 'acc-a', destFolderId: folder }));

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('shareWithAccount', 'unshare', 'downloadStream')).toEqual([]);
    expect(h.drive.callsOf('copyWithin').map((c) => c.args)).toEqual([[file, folder, 'a.bin', { presetId: expect.any(String) }]]);
    expect(job.items?.[0]).toMatchObject({ status: 'done', verified: true });
    expect(job.items?.[0]?.strategyUsed).toBeUndefined();
    expect(h.a.tree(folder)).toEqual([{ name: 'a.bin', size: 10 }]);
  });
});

describe('stream fallback', () => {
  it('streams when canCopy is false, in chunks that are a multiple of 262144', async () => {
    setup();
    const file = h.a.addFile('root', 'big.bin', MIB, { canCopy: false });

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('shareWithAccount', 'copyWithin', 'unshare')).toEqual([]);
    expect(h.drive.sequence('downloadStream', 'resumableUploadFromStream')).toEqual([
      'acc-a:downloadStream',
      'acc-b:resumableUploadFromStream',
    ]);
    expect(h.b.uploadChunkSizes).toEqual([8 * MIB]);
    expect((h.b.uploadChunkSizes[0] ?? 1) % 262144).toBe(0);
    expect(job.items?.[0]).toMatchObject({ status: 'done', strategyUsed: 'stream', verified: true, bytesDone: MIB });
    expect(h.b.node(job.items?.[0]?.destId ?? '').content?.equals(h.a.node(file).content ?? Buffer.alloc(0))).toBe(true);
  });

  it('rounds a custom chunk size down to a multiple of 262144', async () => {
    setup({ chunkSize: 1_000_000 });
    const file = h.a.addFile('root', 'big.bin', MIB, { canCopy: false });

    await run(copyAtoB([file]));

    expect(h.b.uploadChunkSizes).toEqual([3 * 262144]);
  });

  it('reports upload progress and throttles only the byte-progress events', async () => {
    const progressEvents = async (options: TransferEngineOptions): Promise<number[]> => {
      setup({ chunkSize: 262144, ...options });
      const file = h.a.addFile('root', 'big.bin', MIB, { canCopy: false });
      const job = await run(copyAtoB([file]));
      expect(job.status).toBe('completed');
      expect(job.totals).toEqual({ items: 1, done: 1, failed: 0, bytesTotal: MIB, bytesDone: MIB });
      const bytes: number[] = [];
      for (const event of h.events) {
        if (event.type === 'item.updated' && event.payload.item.status === 'running') {
          bytes.push((event.payload.item as { bytesDone?: number }).bytesDone ?? -1);
        }
      }
      // Terminal events are never dropped.
      expect(h.events.some((e) => e.type === 'item.updated' && e.payload.item.status === 'done')).toBe(true);
      expect(h.events.at(-1)?.type).toBe('job.finished');
      return bytes;
    };

    const unthrottled = await progressEvents({ progressThrottleMs: 0 });
    expect(unthrottled).toEqual([0, 0, 262144, 524288, 786432, MIB, MIB]);
    await h.engine.close();
    h.db.close();

    const throttled = await progressEvents({ progressThrottleMs: 60_000, now: () => 1_700_000_000_000 });
    expect(throttled).toEqual([0, 0]);
  });

  it('retries a retryable mid-stream upload failure with a fresh download', async () => {
    setup();
    const file = h.a.addFile('root', 'big.bin', 300_000, { canCopy: false });
    h.b.failUploadAfter = { bytes: 100_000, error: fakeError('server', 503), times: 1 };

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('downloadStream')).toHaveLength(2);
    expect(h.drive.callsOf('resumableUploadFromStream')).toHaveLength(2);
    expect(h.sleeps).toEqual([1000]);
    expect(h.b.tree()).toEqual([{ name: 'big.bin', size: 300_000 }]);
    expect(job.totals.bytesDone).toBe(300_000);
  });

  it('fails the item when the upload breaks mid-stream with a non-retryable error', async () => {
    setup();
    const file = h.a.addFile('root', 'big.bin', 300_000, { canCopy: false });
    h.b.failUploadAfter = { bytes: 100_000, error: fakeError('forbidden', 403), times: 1 };

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('failed');
    expect(job.items?.[0]).toMatchObject({ status: 'failed', strategyUsed: 'stream', bytesDone: 0 });
    expect(job.items?.[0]?.error).toMatch(/^forbidden/);
    expect(h.drive.callsOf('resumableUploadFromStream')).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.b.tree()).toEqual([]);
    expect(job.totals).toMatchObject({ items: 1, done: 0, failed: 1, bytesDone: 0 });
  });
});

describe('files that cannot be transferred', () => {
  it('fails a Google-native file without canCopy and never exports or streams it', async () => {
    setup();
    const doc = h.a.addGoogleDoc('root', 'Notes', { canCopy: false });

    const job = await run(copyAtoB([doc]));

    expect(job.status).toBe('failed');
    expect(job.items?.[0]?.status).toBe('failed');
    expect(job.items?.[0]?.error).toMatch(/^google_native_not_streamable/);
    expect(h.drive.callsOf('downloadStream', 'resumableUploadFromStream', 'copyWithin', 'shareWithAccount')).toEqual([]);
    expect(h.b.tree()).toEqual([]);
  });

  it('fails a Google-native file whose server-side copy fails, after removing the permission', async () => {
    setup();
    const doc = h.a.addGoogleDoc('root', 'Notes');
    h.b.failNext('copyWithin', fakeError('forbidden', 403));

    const job = await run(copyAtoB([doc]));

    expect(job.items?.[0]?.error).toMatch(/^google_native_not_streamable: .*forbidden/);
    expect(h.drive.sequence('shareWithAccount', 'copyWithin', 'unshare')).toEqual([
      'acc-a:shareWithAccount',
      'acc-b:copyWithin',
      'acc-a:unshare',
    ]);
    expect(h.drive.callsOf('downloadStream', 'resumableUploadFromStream')).toEqual([]);
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('copies a Google-native file with permission-copy and verifies it by presence', async () => {
    setup();
    const doc = h.a.addGoogleDoc('root', 'Notes');

    const job = await run(copyAtoB([doc]));

    expect(job.status).toBe('completed');
    expect(job.items?.[0]).toMatchObject({
      status: 'done',
      sizeBytes: 0,
      strategyUsed: 'permission-copy',
      verified: true,
    });
    expect(h.b.childrenOf('root').map((n) => n.mimeType)).toEqual(['application/vnd.google-apps.document']);
  });

  it('rejects files above the size limit before touching the provider', async () => {
    setup({ maxFileBytes: 100 });
    const big = h.a.addFile('root', 'big.bin', 101);
    const ok = h.a.addFile('root', 'ok.bin', 100);

    const job = await run(copyAtoB([big, ok]));

    expect(job.status).toBe('completed_with_errors');
    expect(job.items?.find((i) => i.sourceId === big)?.error).toMatch(/^file_too_large/);
    expect(job.items?.find((i) => i.sourceId === ok)?.status).toBe('done');
    const touched = h.drive.callsOf('shareWithAccount', 'copyWithin', 'downloadStream').map((c) => c.target);
    expect(touched).not.toContain(big);
  });

  it('reports a verification mismatch as failed', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 64);
    h.b.corruptNextWrites = 1;

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('failed');
    expect(job.items?.[0]).toMatchObject({ status: 'failed', verified: false });
    expect(job.items?.[0]?.error).toMatch(/^verification_failed: md5/);
  });
});

describe('folders', () => {
  function buildTree(): { photos: string; fileCount: number; folderCount: number } {
    const photos = h.a.addFolder('root', 'Photos');
    h.a.addFile(photos, 'a.jpg', 10);
    h.a.addFile(photos, 'b.jpg', 20);
    h.a.addFile(photos, 'c.jpg', 30);
    const sub = h.a.addFolder(photos, 'Sub');
    h.a.addFile(sub, 'd.txt', 'dddd');
    h.a.addFile(sub, 'e.txt', 'eeeee');
    h.a.addFile(sub, 'f.txt', 'ffffff');
    const deep = h.a.addFolder(sub, 'Deep');
    h.a.addFile(deep, 'g.txt', 'g');
    h.a.addFolder(photos, 'Empty');
    return { photos, fileCount: 7, folderCount: 4 };
  }

  it('copies a folder recursively with the same tree, folders first, with bounded concurrency', async () => {
    setup();
    const { photos, fileCount, folderCount } = buildTree();

    const job = await run(copyAtoB([photos]));

    expect(job.status).toBe('completed');
    expect(h.b.tree()).toEqual([{ name: 'Photos', children: h.a.tree(photos) }]);
    expect(h.b.tree()).toEqual([
      {
        name: 'Photos',
        children: [
          { name: 'a.jpg', size: 10 },
          { name: 'b.jpg', size: 20 },
          { name: 'c.jpg', size: 30 },
          { name: 'Empty', children: [] },
          {
            name: 'Sub',
            children: [
              { name: 'd.txt', size: 4 },
              { name: 'Deep', children: [{ name: 'g.txt', size: 1 }] },
              { name: 'e.txt', size: 5 },
              { name: 'f.txt', size: 6 },
            ],
          },
        ],
      },
    ]);

    // Bounded concurrency over every provider call of the job.
    expect(h.drive.maxInFlight).toBeLessThanOrEqual(3);
    expect(h.drive.maxInFlight).toBeGreaterThan(1);

    // The whole destination folder tree exists before the first file is touched.
    const lastFolder = Math.max(...h.drive.callsOf('createFolder').map((c) => c.seq));
    const firstFile = Math.min(...h.drive.callsOf('shareWithAccount', 'copyWithin').map((c) => c.seq));
    expect(h.drive.callsOf('createFolder')).toHaveLength(folderCount);
    expect(lastFolder).toBeLessThan(firstFile);
    // ...and the source tree was listed completely before anything was created.
    const firstFolder = Math.min(...h.drive.callsOf('createFolder').map((c) => c.seq));
    const planningLists = h.drive.callsOf('listFolder').filter((c) => c.accountId === 'acc-a' && c.seq < firstFolder);
    expect(new Set(planningLists.map((c) => c.target)).size).toBe(folderCount);

    expect(job.items).toHaveLength(fileCount + folderCount);
    expect(job.items?.every((i) => i.status === 'done' && i.verified === true)).toBe(true);
    expect(job.items?.filter((i) => i.isFolder).every((i) => i.sizeBytes === 0)).toBe(true);
    expect(job.totals).toEqual({
      items: fileCount + folderCount,
      done: fileCount + folderCount,
      failed: 0,
      bytesTotal: 76,
      bytesDone: 76,
    });
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('honours a custom item concurrency', async () => {
    setup({ itemConcurrency: 1 });
    const { photos } = buildTree();

    const job = await run(copyAtoB([photos]));

    expect(job.status).toBe('completed');
    expect(h.drive.maxInFlight).toBe(1);
  });

  it('fails everything below a folder that cannot be created, and still copies the rest', async () => {
    setup();
    const { photos } = buildTree();
    const other = h.a.addFile('root', 'other.bin', 5);
    h.b.failNext('createFolder', fakeError('forbidden', 403));

    const job = await run(copyAtoB([photos, other]));

    expect(job.status).toBe('completed_with_errors');
    const byName = new Map(job.items?.map((i) => [i.name, i]));
    expect(byName.get('Photos')?.error).toMatch(/^forbidden/);
    expect(byName.get('a.jpg')?.error).toMatch(/^parent_failed/);
    expect(byName.get('g.txt')?.error).toMatch(/^parent_failed/);
    expect(byName.get('other.bin')?.status).toBe('done');
    expect(h.b.tree()).toEqual([{ name: 'other.bin', size: 5 }]);
  });
});

describe('retry with backoff', () => {
  it('retries 429 with exponential backoff and still uses permission-copy', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10);
    h.b.failNext('copyWithin', () => fakeError('rate_limit', 429), 3);

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('completed');
    expect(h.sleeps).toEqual([1000, 2000, 4000]);
    expect(h.drive.callsOf('copyWithin')).toHaveLength(4);
    expect(h.drive.callsOf('shareWithAccount')).toHaveLength(1);
    expect(h.drive.callsOf('downloadStream')).toEqual([]);
    expect(job.items?.[0]).toMatchObject({ status: 'done', strategyUsed: 'permission-copy' });
    expect(h.drive.activePermissions()).toEqual([]);
  });

  it('retries 5xx on any call', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10);
    h.a.failNext('getFile', () => fakeError('server', 503), 1);
    h.a.failNext('shareWithAccount', () => fakeError('server', 500), 1);

    const job = await run(copyAtoB([file]));

    expect(job.status).toBe('completed');
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it('gives up after 5 attempts', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10);
    h.a.failNext('getFile', () => fakeError('rate_limit', 429), 99);

    const job = await run(copyAtoB([file]));

    expect(h.drive.callsOf('getFile')).toHaveLength(5);
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(job.status).toBe('failed');
    expect(job.items?.[0]?.error).toMatch(/^rate_limit/);
    expect(job.error).toMatch(/^rate_limit/);
  });

  it('never retries a non-retryable error', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10);
    h.a.failNext('getFile', fakeError('not_found', 404));

    const job = await run(copyAtoB([file]));

    expect(h.drive.callsOf('getFile')).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(job.status).toBe('failed');
    expect(job.items?.[0]).toMatchObject({ status: 'failed', sourceId: file });
    expect(job.items?.[0]?.error).toMatch(/^not_found/);
  });

  it('maps auth errors to the auth code', async () => {
    setup();
    const file = h.a.addFile('root', 'a.bin', 10, { canCopy: false });
    h.a.failNext('downloadStream', fakeError('auth', 401));

    const job = await run(copyAtoB([file]));

    expect(job.items?.[0]?.error).toMatch(/^auth/);
    expect(h.sleeps).toEqual([]);
  });
});

describe('copy mode', () => {
  it('never trashes anything', async () => {
    setup();
    const folder = h.a.addFolder('root', 'Docs');
    h.a.addFile(folder, 'a.txt', 'a');
    const file = h.a.addFile('root', 'b.txt', 'b');

    const job = await run(copyAtoB([folder, file]));

    expect(job.status).toBe('completed');
    expect(h.drive.callsOf('trash')).toEqual([]);
    expect(h.a.tree()).toEqual([
      { name: 'b.txt', size: 1 },
      { name: 'Docs', children: [{ name: 'a.txt', size: 1 }] },
    ]);
  });
});
