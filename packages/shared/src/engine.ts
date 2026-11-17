import type { ProviderResolver } from './provider.ts';
import type { CreateTransferRequest, SseEvent, TransferJob } from './transfers.ts';

/** What the server's transfer engine exposes to the HTTP routes. */
export interface TransferEngine {
  /** Validates the request (rejects `move` without `confirmMove === true`), persists and enqueues it. */
  createJob(req: CreateTransferRequest): Promise<TransferJob>;
  /** All jobs, newest first, without `items`. */
  listJobs(): TransferJob[];
  /** One job including its `items`, or `undefined` when the id is unknown. */
  getJob(id: string): TransferJob | undefined;
  /** Stops a queued/running job. Resolves with the updated job; rejects when the id is unknown. */
  cancel(id: string): Promise<TransferJob>;
  /** Re-queues the failed items of a finished job. Resolves with the updated job. */
  retryFailed(id: string): Promise<TransferJob>;
  /** Registers a listener for progress events. Returns the unsubscribe function. */
  subscribe(listener: (event: SseEvent) => void): () => void;
}

export interface EngineLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface TransferEngineDeps {
  /**
   * A better-sqlite3 `Database` instance. Typed as `unknown` here because the shared package has
   * no runtime dependencies; the server narrows it (`deps.db as Database.Database`) inside its
   * implementation of the factory.
   */
  db: unknown;
  resolveProvider: ProviderResolver;
  /** Synchronous lookup of the email address of a stored account (used for permission-copy). */
  getAccountEmail: (accountId: string) => string;
  logger: EngineLogger;
}

/** Signature of the factory the server implements (packages/core/src/transfer). */
export type CreateTransferEngine = (deps: TransferEngineDeps) => TransferEngine;
