import type { CreateTransferEngine } from '@multicloud/shared';
import { createTransferEngine } from './engine.ts';

// Compile-time proof that the richer factory still fits the shared contract.
createTransferEngine satisfies CreateTransferEngine;

export { createTransferEngine, DEFAULT_UPLOAD_CHUNK_SIZE, UPLOAD_CHUNK_UNIT } from './engine.ts';
export type {
  EngineTransferItem,
  EngineTransferJob,
  TransferEngineHandle,
  TransferEngineOptions,
  WorkBudget,
} from './engine.ts';
export {
  ITEM_ERROR_CODES,
  ITEM_WARNING_CODES,
  JOB_ERROR_CODES,
  TRANSFER_ERROR_CODES,
  TransferError,
  isTransferError,
  redactSecrets,
} from './errors.ts';
export type { ItemErrorCode, ItemWarningCode, JobErrorCode, TransferErrorCode } from './errors.ts';
export { SSE_KEEP_ALIVE_COMMENT, SSE_KEEP_ALIVE_MS, attachSseStream, formatSse } from './sse.ts';
export type { AttachSseOptions, SseResponseLike } from './sse.ts';
export { isSqlDb } from './store.ts';
export type { SqlDb, SqlValue } from './store.ts';
export { DEFAULT_RETRY_POLICY } from './retry.ts';
export { DEFAULT_SUBREQUEST_SAFETY_MARGIN, createSubrequestBudget } from './budget.ts';
export type { SubrequestBudget, SubrequestBudgetOptions } from './budget.ts';
export type { RetryPolicy, SleepFn } from './retry.ts';
