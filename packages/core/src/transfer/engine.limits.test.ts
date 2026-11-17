import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateTransferRequest } from '@multicloud/shared';
import { createHarness } from './testing/harness.ts';
import type { Harness } from './testing/harness.ts';
import { fakeError } from './testing/FakeProvider.ts';
import type { FakeDrive } from './testing/FakeProvider.ts';
import { createSubrequestBudget } from './index.ts';
import type { TransferEngineOptions, WorkBudget } from './index.ts';
import { fromBetterSqlite } from './nodeSql.ts';
import { createTransferStore } from './store.ts';

let h: Harness | undefined;
const setup = (options?: TransferEngineOptions): Harness => {
  h = createHarness(options);
  return h;
};

afterEach(async () => {
  if (h) {
    await h.engine.close();
    h.db.close();
    h = undefined;
  }
});

function request(ids: string[], mode: 'copy' | 'move' = 'copy'): CreateTransferRequest {
  return {
    mode,
    sourceAccountId: 'acc-a',
    destAccountId: 'acc-b',
    destFolderId: 'root',
    sourceFileIds: ids,
    ...(mode === 'move' ? { confirmMove: true } : {}),
  };
}

describe('stream fallback size cap (maxStreamBytes)', () => {
  it('refuses a larger stream-only file up front and copies the rest', async () => {
    const harness = setup({ maxStreamBytes: 1000 });
    const big = harness.a.addFile('root', 'big.bin', 5000, { canCopy: false });
    const small = harness.a.addFile('root', 'small.bin', 500, { canCopy: false });
    const serverSide = harness.a.addFile('root', 'server.bin', 5000);

    const job = await harness.engine.waitForJob((await harness.engine.createJob(request([big, small, serverSide]))).id);

    expect(job.status).toBe('completed_with_errors');
    const byName = new Map(job.items?.map((i) => [i.name, i]));
    expect(byName.get('big.bin')).toMatchObject({ status: 'failed', strategyUsed: 'stream' });
    expect(byName.get('big.bin')?.error).toMatch(/^stream_file_too_large: 5000 bytes exceeds the limit of 1000 bytes/);
    expect(byName.get('big.bin')?.error).not.toMatch(/token|Bearer|ya29/i);
    // Server-side copy is not capped.
    expect(byName.get('server.bin')).toMatchObject({ status: 'done', verified: true, strategyUsed: 'permission-copy' });
    expect(byName.get('small.bin')).toMatchObject({ status: 'done', verified: true, strategyUsed: 'stream' });
    // Nothing was downloaded or uploaded for the refused file; the destination holds no part of it.
    expect(harness.drive.callsOf('downloadStream').map((c) => c.target)).toEqual([small]);
    expect(harness.b.tree().map((n) => n.name)).toEqual(['server.bin', 'small.bin']);
    expect(harness.drive.activePermissions()).toEqual([]);
  });

  it('removes the temporary permission when the copy fails and the stream is refused', async () => {
    const harness = setup({ maxStreamBytes: 10 });
    const file = harness.a.addFile('root', 'a.bin', 100);
    harness.b.failNext('copyWithin', fakeError('forbidden', 403));

    const job = await harness.engine.waitForJob((await harness.engine.createJob(request([file]))).id);

    expect(job.status).toBe('failed');
    expect(job.items?.[0]?.error).toMatch(/^stream_file_too_large/);
    expect(harness.drive.sequence('shareWithAccount', 'copyWithin', 'unshare', 'downloadStream')).toEqual([
      'acc-a:shareWithAccount',
      'acc-b:copyWithin',
      'acc-a:unshare',
    ]);
    expect(harness.drive.activePermissions()).toEqual([]);
    expect(harness.b.tree()).toEqual([]);
  });

  it('is not retried automatically, and a manual retry fails the same way', async () => {
    const harness = setup({ maxStreamBytes: 10 });
    const file = harness.a.addFile('root', 'a.bin', 100, { canCopy: false });
    const created = await harness.engine.createJob(request([file]));
    await harness.engine.waitForJob(created.id);
    expect(harness.sleeps).toEqual([]);

    await harness.engine.retryFailed(created.id);
    const job = await harness.engine.waitForJob(created.id);
    expect(job.items?.[0]?.error).toMatch(/^stream_file_too_large/);
    expect(harness.drive.callsOf('downloadStream', 'resumableUploadFromStream')).toEqual([]);
  });

  it('without a cap (Node host) a large stream-only file is copied as before', async () => {
    const harness = setup();
    const file = harness.a.addFile('root', 'big.bin', 300_000, { canCopy: false });
    const job = await harness.engine.waitForJob((await harness.engine.createJob(request([file]))).id);
    expect(job.status).toBe('completed');
  });
});

describe('createSubrequestBudget', () => {
  it('counts subrequests and keeps a safety margin of 25 by default', () => {
    const budget = createSubrequestBudget({ limit: 100 });
    expect(budget.remaining()).toBe(100);
    expect(budget.canStartItem()).toBe(true);
    budget.count(75);
    expect(budget.remaining()).toBe(25);
    expect(budget.canStartItem()).toBe(true);
    budget.count();
    expect(budget.remaining()).toBe(24);
    expect(budget.canStartItem()).toBe(false);
    budget.count(500);
    expect(budget.remaining()).toBe(0);
  });

  it('honours a custom margin and ignores nonsense counts', () => {
    const budget = createSubrequestBudget({ limit: 10, safetyMargin: 5 });
    budget.count(-3);
    budget.count(Number.NaN);
    expect(budget.remaining()).toBe(10);
    budget.count(5);
    expect(budget.canStartItem()).toBe(true);
    budget.count(1);
    expect(budget.canStartItem()).toBe(false);
  });
});

/** Allows new work while fewer than `limit` provider calls were made in total. */
function callBudget(): WorkBudget & { limit: number; drive?: FakeDrive } {
  return {
    limit: 0,
    canStartItem() {
      return (this.drive?.calls.length ?? 0) < this.limit;
    },
  };
}

describe('work budget hook', () => {
  it('starts nothing when the budget is exhausted before the run', async () => {
    const budget = callBudget();
    const harness = setup({ manual: true, budget });
    budget.drive = harness.drive;
    const created = await harness.engine.createJob(request([harness.a.addFile('root', 'a.bin', 'x')]));

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.drive.calls).toEqual([]);
    expect(harness.engine.hasWork()).toBe(true);
    expect(harness.engine.getJob(created.id)?.status).toBe('queued');
  });

  it('stops starting items, lets in-flight ones finish, and resumes cleanly over several runs', async () => {
    const budget = callBudget();
    const harness = setup({ manual: true, budget, itemConcurrency: 2 });
    budget.drive = harness.drive;
    const files = Array.from({ length: 10 }, (_, i) => harness.a.addFile('root', `f${i}.bin`, 10 + i));
    const created = await harness.engine.createJob(request(files));

    let runs = 0;
    for (; runs < 50; runs++) {
      const status = harness.engine.getJob(created.id)?.status;
      if (status === 'completed' || status === 'failed' || status === 'completed_with_errors') break;
      budget.limit = harness.drive.calls.length + 12; // a few items per run
      harness.engine.start();
      await harness.engine.whenIdle();
      const job = harness.engine.getJob(created.id);
      if (job?.status === 'queued') {
        // Out of budget: nothing half-done, nothing failed, the host must come back.
        expect(harness.engine.hasWork()).toBe(true);
        expect(job.items?.some((i) => i.status === 'running' || i.status === 'failed')).toBe(false);
      }
      await harness.engine.pause();
    }

    const job = harness.engine.getJob(created.id);
    expect(runs).toBeGreaterThan(2);
    expect(job?.status).toBe('completed');
    expect(harness.engine.hasWork()).toBe(false);
    expect(harness.drive.callsOf('copyWithin')).toHaveLength(10);
    expect(harness.b.tree()).toHaveLength(10);
    expect(harness.drive.activePermissions()).toEqual([]);
    expect(harness.events.some((e) => e.type === 'item.updated' && e.payload.item.status === 'failed')).toBe(false);
  });

  it('a move that runs out of budget while trashing finishes the trash in the next run', async () => {
    let trashAllowed = 1;
    const budget: WorkBudget = { canStartItem: () => harness.drive.callsOf('trash').length < trashAllowed };
    const harness = setup({ manual: true, budget });
    const files = ['a', 'b', 'c'].map((name) => harness.a.addFile('root', name, name));
    const created = await harness.engine.createJob(request(files, 'move'));

    harness.engine.start();
    await harness.engine.whenIdle();
    expect(harness.engine.getJob(created.id)?.status).toBe('queued');
    expect(harness.drive.callsOf('trash')).toHaveLength(1);
    await harness.engine.pause();

    trashAllowed = 99;
    harness.engine.start();
    const job = await harness.engine.waitForJob(created.id);

    expect(job.status).toBe('completed');
    expect(harness.drive.callsOf('trash').map((c) => c.target).sort()).toEqual([...files].sort());
    expect(harness.drive.callsOf('copyWithin')).toHaveLength(3);
  });

  it('stops a long folder listing between pages and lists it again next run', async () => {
    let allow = true;
    const budget: WorkBudget = { canStartItem: () => allow };
    const harness = setup({ manual: true, budget });
    const folder = harness.a.addFolder('root', 'many');
    for (let i = 0; i < 6; i++) harness.a.addFile(folder, `n${i}.bin`, 'x'); // 3 pages of 2
    const gate = harness.a.gate('listFolder');
    const created = await harness.engine.createJob(request([folder]));

    harness.engine.start();
    await gate.waitForCalls(1);
    allow = false;
    gate.release();
    await harness.engine.whenIdle();
    expect(harness.engine.getJob(created.id)?.status).toBe('queued');
    expect(harness.drive.callsOf('listFolder')).toHaveLength(1);
    await harness.engine.pause();

    allow = true;
    harness.engine.start();
    const job = await harness.engine.waitForJob(created.id);
    expect(job.status).toBe('completed');
    expect(harness.b.tree()[0]?.children).toHaveLength(6);
  });
});

describe('store schema upgrade', () => {
  const OLD_ITEMS = `CREATE TABLE transfer_items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL, parent_item_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0, source_id TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
    is_folder INTEGER NOT NULL DEFAULT 0, is_google_native INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER, md5 TEXT,
    can_copy INTEGER NOT NULL DEFAULT 0, can_download INTEGER NOT NULL DEFAULT 0, meta_loaded INTEGER NOT NULL DEFAULT 0,
    expanded INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, strategy_used TEXT, error TEXT, warning TEXT, dest_id TEXT,
    verified INTEGER, bytes_done INTEGER NOT NULL DEFAULT 0, permission_id TEXT, source_trashed INTEGER NOT NULL DEFAULT 0)`;

  it('adds dest_preset_id to an existing database, keeps its rows, and is idempotent', () => {
    const raw = new Database(':memory:');
    try {
      raw.exec(OLD_ITEMS);
      raw.prepare(`INSERT INTO transfer_items (id, job_id, source_id, name, status) VALUES ('old', 'j', 's', 'n', 'done')`).run();
      const db = fromBetterSqlite(raw);

      const store = createTransferStore(db);
      expect(store.getItem('old')).toMatchObject({ id: 'old', status: 'done', destPresetId: null });
      store.updateItem('old', { destPresetId: 'preset-1' });
      expect(store.getItem('old')?.destPresetId).toBe('preset-1');

      const again = createTransferStore(db);
      expect(again.getItem('old')?.destPresetId).toBe('preset-1');
      const columns = (raw.prepare('PRAGMA table_info(transfer_items)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns.filter((c) => c === 'dest_preset_id')).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it('an engine started on an old database resumes its unfinished job', async () => {
    const harness = setup({ manual: true });
    const file = harness.a.addFile('root', 'a.bin', 'hello');
    // Rebuild the items table in its old shape and leave an unfinished job behind.
    const created = await harness.engine.createJob(request([file]));
    harness.db.exec('DROP TABLE transfer_items');
    harness.db.exec(OLD_ITEMS);
    harness.db
      .prepare(`INSERT INTO transfer_items (id, job_id, source_id, name, status, meta_loaded, can_copy, size_bytes)
                VALUES ('old', ?, ?, 'a.bin', 'running', 1, 1, 5)`)
      .run(created.id, file);

    const next = harness.restart({ manual: true });
    try {
      next.start();
      const job = await next.waitForJob(created.id);
      expect(job.status).toBe('completed');
      expect(harness.b.tree()).toEqual([{ name: 'a.bin', size: 5 }]);
    } finally {
      await next.close();
    }
  });
});
