export type TransferMode = 'copy' | 'move';

/**
 * `permission-copy`: share the source file with the destination account, copy it server-side,
 * then remove the temporary permission. `stream`: download from source and upload to destination.
 */
export type TransferStrategy = 'permission-copy' | 'stream';

export type TransferJobStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'canceled';

export type TransferItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'canceled';

export interface TransferItem {
  id: string;
  jobId: string;
  /** Provider file id in the source account. */
  sourceId: string;
  name: string;
  isFolder: boolean;
  /** 0 when unknown or not applicable (folders, Google-native files). */
  sizeBytes: number;
  status: TransferItemStatus;
  strategyUsed?: TransferStrategy;
  error?: string;
  /** Provider file id created in the destination account. */
  destId?: string;
  /** True once the destination copy was checked against the source (size / md5). */
  verified?: boolean;
  /** Bytes transferred so far (stream strategy), or the full size once done. */
  bytesDone?: number;
  /** Non-fatal problem on an item that otherwise succeeded: `<ItemWarningCode>` or `<code>: <detail>`. */
  warning?: string;
  /** Move jobs: true once this selected (top-level) source was moved to the trash. */
  sourceTrashed?: boolean;
  /** Move jobs: true once that trashed source was deleted forever (explicit purge). */
  sourcePurged?: boolean;
}

/**
 * Machine codes that open `TransferItem.error`. The wire format of `TransferItem.error`,
 * `TransferItem.warning` and `TransferJob.error` is `<code>` or `<code>: <detail>`.
 */
export const ITEM_ERROR_CODES = [
  'google_native_not_streamable',
  /** A Drive shortcut whose target the destination account cannot reach (or that was not copied). */
  'shortcut_target_unavailable',
  'file_too_large',
  /** Stream fallback only: the file exceeds the host's per-run cap (engine option `maxStreamBytes`). */
  'stream_file_too_large',
  'verification_failed',
  'parent_failed',
  'interrupted',
  'canceled',
  'rate_limit',
  'auth',
  'not_found',
  'forbidden',
  'server',
  'unknown',
] as const;

export type ItemErrorCode = (typeof ITEM_ERROR_CODES)[number];

/** Codes that open `TransferItem.warning` (the item itself still succeeded). */
export const ITEM_WARNING_CODES = ['unshare_failed', 'trash_failed', 'purge_skipped', 'purge_failed'] as const;

export type ItemWarningCode = (typeof ITEM_WARNING_CODES)[number];

/** Codes that open `TransferJob.error`, in addition to every ItemErrorCode. */
export const JOB_ERROR_CODES = ['move_not_verified', 'move_not_confirmed', 'trash_failed'] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number] | ItemErrorCode;

/** Splits `<code>` / `<code>: <detail>` (the format of item errors, item warnings and job errors). */
export function splitCodedMessage(raw: string): { code: string; detail: string } {
  const separator = raw.indexOf(':');
  if (separator < 0) return { code: raw.trim(), detail: '' };
  return { code: raw.slice(0, separator).trim(), detail: raw.slice(separator + 1).trim() };
}

export interface TransferTotals {
  items: number;
  done: number;
  failed: number;
  bytesTotal: number;
  bytesDone: number;
}

export interface TransferJob {
  id: string;
  mode: TransferMode;
  sourceAccountId: string;
  destAccountId: string;
  destFolderId: string;
  status: TransferJobStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp, set once the job reached a terminal status. */
  finishedAt?: string;
  totals: TransferTotals;
  /** Why the job did not fully succeed: `<JobErrorCode>` or `<code>: <detail>`. Absent on success. */
  error?: string;
  /**
   * Present on single-job responses (`getJob`), omitted in lists. A large job returns only part of
   * its items (selected sources, failures, running items and items with a warning first).
   */
  items?: TransferItem[];
  /** Single-job responses: how many items were left out of `items` (absent when none). */
  itemsOmitted?: number;
  /**
   * Move jobs: selected sources now in the source account's trash (still using its storage), and
   * those already deleted forever by an explicit purge.
   */
  trash?: { trashed: number; purged: number };
}

/** POST /api/transfers/:id/purge-trashed body: must be exactly true, nothing is deleted otherwise. */
export interface PurgeTrashedRequest {
  confirmPermanentDelete: boolean;
}

/** Result of one purge call. `remaining` > 0: call again (each call handles a bounded batch). */
export interface PurgeTrashedResult {
  job: TransferJob;
  purged: number;
  skipped: number;
  failed: number;
  remaining: number;
}

export interface CreateTransferRequest {
  mode: TransferMode;
  sourceAccountId: string;
  destAccountId: string;
  destFolderId: string;
  sourceFileIds: string[];
  /** A `move` request is rejected unless this is exactly `true`. */
  confirmMove?: boolean;
}

/**
 * Events of GET /api/events (text/event-stream). Wire format of one event:
 *
 *     event: <type>
 *     data: <JSON of the whole event, i.e. {"type":...,"payload":...}>
 *     <blank line>
 *
 * Jobs inside events never carry `items`. Lines starting with ':' (`:keep-alive`) are comments.
 */
export type SseEvent =
  | { type: 'job.created'; payload: { job: TransferJob } }
  | { type: 'job.updated'; payload: { job: TransferJob } }
  | { type: 'item.updated'; payload: { jobId: string; item: TransferItem } }
  | { type: 'job.finished'; payload: { job: TransferJob } };

export type SseEventType = SseEvent['type'];

export const SSE_EVENT_TYPES: readonly SseEventType[] = [
  'job.created',
  'job.updated',
  'item.updated',
  'job.finished',
];

export const TERMINAL_JOB_STATUSES: readonly TransferJobStatus[] = [
  'completed',
  'completed_with_errors',
  'failed',
  'canceled',
];

export function isTerminalJobStatus(status: TransferJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** Returns an error message when the request must be rejected before any work starts, else `null`. */
export function validateCreateTransferRequest(req: CreateTransferRequest): string | null {
  if (req.mode !== 'copy' && req.mode !== 'move') return 'mode must be "copy" or "move"';
  if (!req.sourceAccountId) return 'sourceAccountId is required';
  if (!req.destAccountId) return 'destAccountId is required';
  if (!req.destFolderId) return 'destFolderId is required';
  if (!Array.isArray(req.sourceFileIds) || req.sourceFileIds.length === 0) {
    return 'sourceFileIds must contain at least one file id';
  }
  if (req.mode === 'move' && req.confirmMove !== true) {
    return 'move requires confirmMove === true';
  }
  return null;
}
