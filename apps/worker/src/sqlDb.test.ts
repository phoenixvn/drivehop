import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTransferEngine } from '@multicloud/core';
import { fromDurableObject } from './sqlDb.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('SqlDb adapter on Durable Object SQLite', () => {
  it('throws synchronously on SQL errors (the store migration probe relies on it)', async () => {
    const stub = env.CORE.get(env.CORE.idFromName('sqldb-sync-throw'));
    await runInDurableObject(stub, (_instance, state) => {
      const db = fromDurableObject(state.storage);
      expect(() => db.get('SELECT no_such_column FROM no_such_table')).toThrow();
      expect(() => db.run('INSERT INTO no_such_table VALUES (1)')).toThrow();
    });
  });

  it('creates (and migrates) the transfer store twice on the same storage', async () => {
    const stub = env.CORE.get(env.CORE.idFromName('sqldb-store-twice'));
    await runInDurableObject(stub, async (_instance, state) => {
      const deps = {
        db: fromDurableObject(state.storage),
        resolveProvider: async () => {
          throw new Error('not used');
        },
        getAccountEmail: () => 'x@example.com',
        logger: silent,
      };
      const first = createTransferEngine(deps, { manual: true });
      await first.close();
      const second = createTransferEngine(deps, { manual: true });
      expect(second.listJobs()).toEqual([]);
      await second.close();
      const columns = state.storage.sql.exec("SELECT name FROM pragma_table_info('transfer_items')").toArray().map((r) => r.name);
      expect(columns).toContain('dest_preset_id');
    });
  });

  it('upgrades a transfer_items table created before dest_preset_id and share_pending (guarded ALTER inside workerd)', async () => {
    const stub = env.CORE.get(env.CORE.idFromName('sqldb-upgrade-dest-preset-id'));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // The object's constructor already created the current tables; replace them with the first
      // released schema (identical except for the missing dest_preset_id column).
      sql.exec('DROP TABLE IF EXISTS transfer_items');
      sql.exec('DROP TABLE IF EXISTS transfer_jobs');
      sql.exec(`CREATE TABLE transfer_jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL,
        source_account_id TEXT NOT NULL, dest_account_id TEXT NOT NULL, dest_folder_id TEXT NOT NULL,
        source_file_ids TEXT NOT NULL, confirm_move INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, finished_at TEXT)`);
      sql.exec(`CREATE TABLE transfer_items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL,
        parent_item_id TEXT, depth INTEGER NOT NULL DEFAULT 0, source_id TEXT NOT NULL, name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '', is_folder INTEGER NOT NULL DEFAULT 0,
        is_google_native INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER, md5 TEXT,
        can_copy INTEGER NOT NULL DEFAULT 0, can_download INTEGER NOT NULL DEFAULT 0,
        meta_loaded INTEGER NOT NULL DEFAULT 0, expanded INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        strategy_used TEXT, error TEXT, warning TEXT, dest_id TEXT, verified INTEGER,
        bytes_done INTEGER NOT NULL DEFAULT 0, permission_id TEXT, source_trashed INTEGER NOT NULL DEFAULT 0)`);
      sql.exec(
        `INSERT INTO transfer_jobs (id, mode, source_account_id, dest_account_id, dest_folder_id, source_file_ids, status, created_at, finished_at)
         VALUES ('job-old', 'copy', 'a', 'b', 'root', '["f1"]', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')`,
      );
      sql.exec(
        `INSERT INTO transfer_items (id, job_id, source_id, name, status, dest_id, verified, meta_loaded)
         VALUES ('item-old', 'job-old', 'f1', 'old.txt', 'done', 'd1', 1, 1)`,
      );
      const before = sql.exec("SELECT name FROM pragma_table_info('transfer_items')").toArray().map((r) => r.name);
      expect(before).not.toContain('dest_preset_id');
      expect(before).not.toContain('share_pending');

      const engine = createTransferEngine(
        {
          db: fromDurableObject(state.storage),
          resolveProvider: async () => {
            throw new Error('not used');
          },
          getAccountEmail: () => 'x@example.com',
          logger: silent,
        },
        { manual: true },
      );
      const after = sql.exec("SELECT name FROM pragma_table_info('transfer_items')").toArray().map((r) => r.name);
      expect(after).toContain('dest_preset_id');
      expect(after).toContain('share_pending');
      const job = engine.getJob('job-old');
      expect(job?.status).toBe('completed');
      expect(job?.items?.map((i) => [i.name, i.status, i.destId])).toEqual([['old.txt', 'done', 'd1']]);
      await engine.close();
      // A second construction on the upgraded table is a no-op.
      const again = createTransferEngine(
        {
          db: fromDurableObject(state.storage),
          resolveProvider: async () => {
            throw new Error('not used');
          },
          getAccountEmail: () => 'x@example.com',
          logger: silent,
        },
        { manual: true },
      );
      expect(again.getJob('job-old')?.status).toBe('completed');
      await again.close();
    });
  });
});
