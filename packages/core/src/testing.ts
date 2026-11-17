// Test-support entry (`@multicloud/core/testing`): the in-memory fake Drive. It needs `Buffer`,
// `node:crypto` and `node:stream` (Node, or Workers with `nodejs_compat`). The engine harness
// (transfer/testing/harness.ts) is deliberately NOT exported: it imports better-sqlite3.
export * from './transfer/testing/FakeProvider.ts';
