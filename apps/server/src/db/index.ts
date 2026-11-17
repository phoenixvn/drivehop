import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** The better-sqlite3 handle shared with the transfer engine (which owns its own tables). */
export type Db = Database.Database;

export const DB_FILE_NAME = 'multicloud.sqlite';

/**
 * Versioned migrations of the server core. Index + 1 is the schema version stored in
 * `core_schema_version`. Append only; never edit a migration that has shipped.
 * The transfer engine creates and migrates its own tables separately.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     email TEXT NOT NULL,
     display_name TEXT NOT NULL,
     avatar_url TEXT,
     status TEXT NOT NULL DEFAULT 'connected',
     refresh_token_enc BLOB,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (provider, email)
   )`,
];

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS core_schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS version FROM core_schema_version').get() as
    | { version: number | null }
    | undefined;
  const current = row?.version ?? 0;
  const apply = db.transaction((from: number) => {
    for (let index = from; index < MIGRATIONS.length; index += 1) {
      const sql = MIGRATIONS[index];
      if (sql === undefined) continue;
      db.exec(sql);
      db.prepare('INSERT INTO core_schema_version (version) VALUES (?)').run(index + 1);
    }
  });
  apply(current);
}

export interface OpenDatabaseOptions {
  /** Directory of the database file; created when missing. Ignored when `memory` is true. */
  dataDir?: string;
  /** Use a private in-memory database (tests). */
  memory?: boolean;
}

/** Opens (and migrates) the database at `<dataDir>/multicloud.sqlite`, or an in-memory one. */
export function openDatabase(options: OpenDatabaseOptions): Db {
  let db: Db;
  if (options.memory === true) {
    db = new Database(':memory:');
  } else {
    if (options.dataDir === undefined) throw new Error('openDatabase: dataDir is required');
    mkdirSync(options.dataDir, { recursive: true });
    db = new Database(path.join(options.dataDir, DB_FILE_NAME));
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
