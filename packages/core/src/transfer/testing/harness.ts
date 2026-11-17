import Database from 'better-sqlite3';
import type { EngineLogger, SseEvent } from '@multicloud/shared';
import { createTransferEngine } from '../index.ts';
import type { TransferEngineHandle, TransferEngineOptions } from '../index.ts';
import { FakeDrive } from './FakeProvider.ts';
import type { FakeProvider } from './FakeProvider.ts';

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Harness {
  drive: FakeDrive;
  /** Source account 'acc-a' (a@example.com). */
  a: FakeProvider;
  /** Destination account 'acc-b' (b@example.com). */
  b: FakeProvider;
  db: Database.Database;
  engine: TransferEngineHandle;
  events: SseEvent[];
  /** Delays requested from the injected sleep, in order. */
  sleeps: number[];
  logs: LogLine[];
  /** A second engine on the same database (simulates a process restart). */
  restart(options?: TransferEngineOptions): TransferEngineHandle;
}

/** Engine + fake cloud + in-memory SQLite, with instant sleep, no jitter and no event throttling. */
export function createHarness(options: TransferEngineOptions = {}): Harness {
  const drive = new FakeDrive();
  const a = drive.addAccount('acc-a', 'a@example.com');
  const b = drive.addAccount('acc-b', 'b@example.com');
  const db = new Database(':memory:');
  const events: SseEvent[] = [];
  const sleeps: number[] = [];
  const logs: LogLine[] = [];
  const logger: EngineLogger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };
  let counter = 0;
  const defaults: TransferEngineOptions = {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    progressThrottleMs: 0,
    generateId: () => `id-${++counter}`,
  };
  const make = (extra: TransferEngineOptions = {}): TransferEngineHandle => {
    const engine = createTransferEngine(
      {
        db,
        resolveProvider: async (accountId) => drive.provider(accountId),
        getAccountEmail: (accountId) => drive.email(accountId),
        logger,
      },
      { ...defaults, ...options, ...extra },
    );
    engine.subscribe((event) => events.push(event));
    return engine;
  };
  return { drive, a, b, db, engine: make(), events, sleeps, logs, restart: make };
}
