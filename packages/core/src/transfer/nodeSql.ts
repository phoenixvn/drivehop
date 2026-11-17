import type { SqlDb, SqlValue } from './store.ts';

/** Structural view of the parts of a better-sqlite3 `Database` the adapter uses. */
export interface BetterSqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}

export function fromBetterSqlite(db: BetterSqliteLike): SqlDb {
  const cache = new Map<string, ReturnType<BetterSqliteLike['prepare']>>();
  const stmt = (sql: string): ReturnType<BetterSqliteLike['prepare']> => {
    let prepared = cache.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      cache.set(sql, prepared);
    }
    return prepared;
  };
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, ...params) => void stmt(sql).run(...params),
    get: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).all(...params) as T[],
    transaction: (fn) => db.transaction(fn)(),
  };
}
