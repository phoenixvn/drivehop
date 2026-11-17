import type { SqlDb, SqlValue } from '@multicloud/core';

/** The engine's SQL surface on top of a SQLite-backed Durable Object. */
export function fromDurableObject(storage: DurableObjectStorage): SqlDb {
  const sql = storage.sql;
  return {
    exec: (statements) => void sql.exec(statements),
    run: (query, ...params: SqlValue[]) => void sql.exec(query, ...params),
    get: <T>(query: string, ...params: SqlValue[]) => sql.exec(query, ...params).toArray()[0] as T | undefined,
    all: <T>(query: string, ...params: SqlValue[]) => sql.exec(query, ...params).toArray() as T[],
    transaction: (fn) => storage.transactionSync(fn),
  };
}
