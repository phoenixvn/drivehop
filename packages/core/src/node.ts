// Node-host entry (`@multicloud/core/node`): adapters that only make sense next to better-sqlite3.
// Nothing here imports better-sqlite3 itself (the adapter is structural), but Workers never need it.
export { fromBetterSqlite } from './transfer/nodeSql.ts';
export type { BetterSqliteLike } from './transfer/nodeSql.ts';
