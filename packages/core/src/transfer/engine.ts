import { randomUUID } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GOOGLE_LIMITS,
  PROVIDER_ERROR_CODES,
  SHORTCUT_MIME_TYPE,
  isPresetIdConflict,
  isTerminalJobStatus,
  validateCreateTransferRequest,
} from '@multicloud/shared';
import type {
  CloudProvider,
  CreateTransferRequest,
  FileEntry,
  PurgeTrashedResult,
  ShareOptions,
  SseEvent,
  TransferEngine,
  TransferEngineDeps,
  TransferItem,
  TransferJob,
  TransferJobStatus,
  TransferStrategy,
} from '@multicloud/shared';
import {
  CancelError,
  ItemFailure,
  TransferError,
  asProviderError,
  formatError,
  isCancelError,
} from './errors.ts';
import type { WorkBudget } from './budget.ts';
import { createLimiter } from './limiter.ts';
import type { Limiter } from './limiter.ts';
import { DEFAULT_RETRY_POLICY, defaultSleep, withRetry } from './retry.ts';
import type { RetryContext, RetryPolicy, SleepFn } from './retry.ts';
import { fromBetterSqlite } from './nodeSql.ts';
import type { BetterSqliteLike } from './nodeSql.ts';
import { createTransferStore, isSqlDb } from './store.ts';
import type { ItemLite, ItemPatch, ItemRecord, JobPatch, JobRecord, NewItem, SqlDb } from './store.ts';

/** Google resumable uploads need chunks that are a multiple of 256 KiB. */
export const UPLOAD_CHUNK_UNIT = 262_144;
export const DEFAULT_UPLOAD_CHUNK_SIZE = 32 * UPLOAD_CHUNK_UNIT; // 8 MiB

const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
const MAX_ANCESTOR_DEPTH = 100;
const MAX_LIST_PAGES = 100_000;
const SHUTDOWN = 'shutdown';
const CANCEL = 'cancel';
const PAUSE = 'pause';
/** Destination ids requested per `generateIds` call (Drive allows up to 1000). */
const PRESET_ID_BATCH = 100;
/** Items returned by getJob: a job may hold tens of thousands, far too many for one response. */
export const MAX_VIEW_ITEMS = 2000;
/** Pending files loaded per page by copyFiles (memory stays flat however large the job is). */
const COPY_PAGE_SIZE = 500;

export type { WorkBudget } from './budget.ts';

/** Internal: the work budget ran out. Handled like a pause: the item stays pending for the next run. */
class BudgetStop extends CancelError {}

export interface TransferEngineOptions {
  /** Jobs running at the same time. Default 1. */
  jobConcurrency?: number;
  /** Provider operations in flight per job (planning, folders, files, verification). Default 3. */
  itemConcurrency?: number;
  /** Upload chunk size for the stream strategy; rounded down to a multiple of 262144. Default 8 MiB. */
  chunkSize?: number;
  /** Backoff for retryable ProviderErrors. Default: base 1000 ms, factor 2, 5 attempts. */
  retry?: Partial<RetryPolicy>;
  /** Injectable for tests. The default resolves early when the signal aborts. */
  sleep?: SleepFn;
  /** Epoch milliseconds. Default Date.now. */
  now?: () => number;
  /** Jitter source in [0, 1). Default Math.random. */
  random?: () => number;
  /** Default crypto.randomUUID. */
  generateId?: () => string;
  /** Minimum gap between byte-progress events of one item / totals events of one job. Default 250; 0 disables throttling. */
  progressThrottleMs?: number;
  /** Largest file that may be transferred. Default GOOGLE_LIMITS.maxCopyFileBytes. */
  maxFileBytes?: number;
  /**
   * Host-driven mode for hosts where no invocation lives long (a Durable Object driven by alarms).
   * Jobs run only between `start()` and `pause()`; creating or retrying a job just queues it.
   * Jobs found unfinished at startup are queued again and RESUMED instead of being marked failed,
   * and the leftover-permission sweep is not started automatically (the host calls it).
   */
  manual?: boolean;
  /**
   * Cap, in bytes, of the stream fallback (download then upload). A larger file is refused before
   * anything is downloaded, with the item error code 'stream_file_too_large' (a file of unknown size
   * is cut off once it passes the cap, before the upload is finalized). Server-side copies are not
   * subject to it. Undefined (the Node host) means no cap.
   */
  maxStreamBytes?: number;
  /**
   * See WorkBudget. Consulted before a job starts, before each item starts, before each further page
   * of a folder listing and before each source is trashed. Undefined means unlimited.
   */
  budget?: WorkBudget;
}

/** TransferItem plus engine-specific detail (a structural superset of the shared type). */
export interface EngineTransferItem extends TransferItem {
  /** Bytes uploaded so far (stream strategy) or the full size once done. */
  bytesDone: number;
  /** Non-fatal problem on an item that otherwise succeeded: `unshare_failed: ...` or `trash_failed: ...`. */
  warning?: string;
  /** Move jobs: true once this top-level source was moved to the trash. */
  sourceTrashed?: boolean;
}

/** TransferJob plus engine-specific detail (a structural superset of the shared type). */
export interface EngineTransferJob extends TransferJob {
  /** Why the job did not fully succeed, `<code>` or `<code>: <detail>` (e.g. `move_not_verified: ...`). */
  error?: string;
  items?: EngineTransferItem[];
}

export interface TransferEngineHandle extends TransferEngine {
  createJob(req: CreateTransferRequest): Promise<EngineTransferJob>;
  listJobs(): EngineTransferJob[];
  getJob(id: string): EngineTransferJob | undefined;
  cancel(id: string): Promise<EngineTransferJob>;
  retryFailed(id: string): Promise<EngineTransferJob>;
  /**
   * PERMANENT delete, only on explicit user confirmation: for a finished move job, deletes forever
   * the selected sources that this job moved to the trash, at most `maxItems` per call. Each one is
   * deleted only if its destination copy still exists and it is still in the trash (a source the
   * user restored is left alone). Never touches anything else in the trash.
   */
  purgeTrashedSources(id: string, options?: { maxItems?: number }): Promise<PurgeTrashedResult>;
  /** Resolves with the job (including items) once it reached a terminal status. Rejects on an unknown id. */
  waitForJob(id: string): Promise<EngineTransferJob>;
  /**
   * Resolves once nothing is running and nothing more will start in this invocation: the queue is
   * empty, or (manual mode) the gate is closed, or the work budget is exhausted. `hasWork()` tells
   * whether queued work is left for a later run.
   */
  whenIdle(): Promise<void>;
  /**
   * Removes temporary reader permissions that an earlier process left behind (crash, kill, power
   * loss) on source files. Runs once at startup; concurrent calls share one run. Resolves with the
   * number of permissions removed. Never rejects.
   */
  cleanupOrphanPermissions(): Promise<number>;
  /**
   * Shutdown: stops accepting work, aborts running jobs (they are persisted as failed 'interrupted'
   * and can be retried), waits for their cleanup and drops all listeners. Does NOT close the database.
   */
  close(): Promise<void>;
  /** Manual mode: opens the gate and starts queued jobs in the caller's invocation. */
  start(): void;
  /**
   * Manual mode: closes the gate, lets in-flight provider calls finish, and puts running jobs
   * back in the queue with their unfinished items pending. Nothing is reported as failed.
   */
  pause(): Promise<void>;
  /** True while a job is queued or running. */
  hasWork(): boolean;
}

interface RunContext {
  job: JobRecord;
  signal: AbortSignal;
  source: CloudProvider;
  dest: CloudProvider;
  sameAccount: boolean;
  destEmail: string;
  limiter: Limiter;
  /** Abortable retry settings for normal work. */
  retry: RetryContext;
  /** Ids created at the destination by this job; never treated as source children. */
  destIds: Set<string>;
  /** Destination ids reserved by `generateIds` and not handed to an item yet. */
  idPool: string[];
  /** The `generateIds` call in flight, shared by every item waiting for an id. */
  idRefill: Promise<void> | undefined;
  /** Set once the work budget refused new work: this run starts nothing more. */
  budgetStopped: boolean;
}

interface RunningJob {
  ctl: AbortController;
  promise: Promise<void>;
}

type VerifyResult = { ok: true; sizeBytes: number | null } | { ok: false; detail: string };

function normalizeChunkSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_UPLOAD_CHUNK_SIZE;
  return Math.max(UPLOAD_CHUNK_UNIT, Math.floor(value / UPLOAD_CHUNK_UNIT) * UPLOAD_CHUNK_UNIT);
}

function isGoogleNativeEntry(entry: FileEntry): boolean {
  if (entry.isFolder) return false;
  return entry.isGoogleNative || entry.mimeType.startsWith(GOOGLE_NATIVE_PREFIX);
}

function metaPatch(entry: FileEntry): ItemPatch {
  return {
    name: entry.name,
    mimeType: entry.mimeType,
    isFolder: entry.isFolder,
    isGoogleNative: isGoogleNativeEntry(entry),
    sizeBytes: entry.isFolder ? null : entry.sizeBytes,
    md5: entry.md5Checksum ?? null,
    canCopy: entry.capabilities.canCopy,
    canDownload: entry.capabilities.canDownload,
    metaLoaded: true,
  };
}

function itemView(record: ItemRecord): EngineTransferItem {
  const view: EngineTransferItem = {
    id: record.id,
    jobId: record.jobId,
    sourceId: record.sourceId,
    name: record.name,
    isFolder: record.isFolder,
    sizeBytes: record.sizeBytes ?? 0,
    status: record.status,
    bytesDone: record.bytesDone,
  };
  if (record.strategyUsed !== null) view.strategyUsed = record.strategyUsed;
  if (record.error !== null) view.error = record.error;
  if (record.destId !== null) view.destId = record.destId;
  if (record.verified !== null) view.verified = record.verified;
  if (record.warning !== null) view.warning = record.warning;
  if (record.sourceTrashed) view.sourceTrashed = true;
  if (record.sourcePurged) view.sourcePurged = true;
  return view;
}

function compareWithSource(item: ItemRecord, dest: FileEntry): VerifyResult {
  if (item.sizeBytes !== null && dest.sizeBytes !== null && item.sizeBytes !== dest.sizeBytes) {
    return { ok: false, detail: `size mismatch (source ${item.sizeBytes} bytes, destination ${dest.sizeBytes} bytes)` };
  }
  if (item.md5 !== null && dest.md5Checksum !== undefined && item.md5 !== dest.md5Checksum) {
    return { ok: false, detail: 'md5 checksum mismatch' };
  }
  return { ok: true, sizeBytes: dest.sizeBytes };
}

export function createTransferEngine(
  deps: TransferEngineDeps,
  options: TransferEngineOptions = {},
): TransferEngineHandle {
  // `deps.db` is either a ready SqlDb (Durable Object host) or a better-sqlite3 Database (Node host).
  const rawDb = deps.db as BetterSqliteLike | SqlDb | null;
  let db: SqlDb;
  if (isSqlDb(rawDb)) {
    db = rawDb;
  } else if (rawDb !== null && typeof rawDb === 'object' && typeof rawDb.prepare === 'function') {
    db = fromBetterSqlite(rawDb);
  } else {
    throw new TypeError('createTransferEngine: deps.db must be a SqlDb or a better-sqlite3 Database');
  }
  const { logger } = deps;
  const store = createTransferStore(db);

  const jobConcurrency = Math.max(1, Math.floor(options.jobConcurrency ?? 1));
  const itemConcurrency = Math.max(1, Math.floor(options.itemConcurrency ?? 3));
  const chunkSize = normalizeChunkSize(options.chunkSize);
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const generateId = options.generateId ?? randomUUID;
  const throttleMs = Math.max(0, options.progressThrottleMs ?? 250);
  const maxFileBytes = options.maxFileBytes ?? GOOGLE_LIMITS.maxCopyFileBytes;
  const maxStreamBytes =
    options.maxStreamBytes !== undefined && Number.isFinite(options.maxStreamBytes)
      ? Math.max(0, options.maxStreamBytes)
      : undefined;
  const budget = options.budget;

  const listeners = new Set<(event: SseEvent) => void>();
  const queue: string[] = [];
  const running = new Map<string, RunningJob>();
  const finishWaiters = new Map<string, Array<() => void>>();
  const idleWaiters: Array<() => void> = [];
  const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastJobEmit = new Map<string, number>();
  const lastProgressEmit = new Map<string, number>();
  let closed = false;
  const manual = options.manual === true;
  /** Manual mode only: jobs may start while this is true. */
  let gateOpen = false;

  const isoNow = (): string => new Date(now()).toISOString();

  if (manual) {
    const resumed = store.requeueUnfinished();
    queue.push(...resumed);
    if (resumed.length > 0) logger.info(`transfer: ${resumed.length} unfinished job(s) queued to resume`);
  } else {
    const recovered = store.recoverInterrupted(isoNow());
    if (recovered > 0) logger.warn(`transfer: marked ${recovered} interrupted job(s) as failed after restart`);
  }

  /** Retry settings for cleanup work that must run even after a cancel. */
  const cleanupRetry: RetryContext = { policy, sleep: (ms) => sleep(ms), random };

  // ---------------------------------------------------------------- views & events

  function jobView(record: JobRecord, withItems: boolean): EngineTransferJob {
    const view: EngineTransferJob = {
      id: record.id,
      mode: record.mode,
      sourceAccountId: record.sourceAccountId,
      destAccountId: record.destAccountId,
      destFolderId: record.destFolderId,
      status: record.status,
      createdAt: record.createdAt,
      totals: store.totals(record.id),
    };
    if (record.finishedAt !== null) view.finishedAt = record.finishedAt;
    if (record.error !== null) view.error = record.error;
    if (record.mode === 'move') view.trash = store.trashCounts(record.id);
    if (withItems) {
      view.items = store.listItemsForView(record.id, MAX_VIEW_ITEMS).map(itemView);
      const omitted = store.countItems(record.id) - view.items.length;
      if (omitted > 0) view.itemsOmitted = omitted;
    }
    return view;
  }

  function emit(event: SseEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        logger.warn('transfer: an event listener threw', error);
      }
    }
  }

  function emitItem(itemId: string): void {
    const record = store.getItem(itemId);
    if (record) emit({ type: 'item.updated', payload: { jobId: record.jobId, item: itemView(record) } });
  }

  function clearJobTimer(jobId: string): void {
    const timer = jobTimers.get(jobId);
    if (timer !== undefined) clearTimeout(timer);
    jobTimers.delete(jobId);
  }

  function emitJobNow(jobId: string): void {
    clearJobTimer(jobId);
    lastJobEmit.set(jobId, now());
    const record = store.getJob(jobId);
    if (record) emit({ type: 'job.updated', payload: { job: jobView(record, false) } });
  }

  /** Totals changed: emit `job.updated` now, or (throttled) once the remaining gap has passed. */
  function touchJob(jobId: string): void {
    if (throttleMs === 0) {
      emitJobNow(jobId);
      return;
    }
    const elapsed = now() - (lastJobEmit.get(jobId) ?? Number.NEGATIVE_INFINITY);
    if (elapsed >= throttleMs) {
      emitJobNow(jobId);
      return;
    }
    if (jobTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      jobTimers.delete(jobId);
      if (!closed && running.has(jobId)) emitJobNow(jobId);
    }, throttleMs - elapsed);
    timer.unref?.();
    jobTimers.set(jobId, timer);
  }

  /** Persists a state change of one item and announces it (never throttled). */
  function updateItem(item: ItemRecord, patch: ItemPatch): ItemRecord {
    store.updateItem(item.id, patch);
    emitItem(item.id);
    touchJob(item.jobId);
    return store.getItem(item.id) ?? { ...item, ...patch };
  }

  function setJob(jobId: string, patch: JobPatch): void {
    store.updateJob(jobId, patch);
    emitJobNow(jobId);
  }

  /** Byte progress of a running upload; the only throttled item event. */
  function reportProgress(item: ItemRecord, bytesSent: number, force = false): void {
    const t = now();
    if (!force && throttleMs > 0 && t - (lastProgressEmit.get(item.id) ?? Number.NEGATIVE_INFINITY) < throttleMs) {
      return;
    }
    lastProgressEmit.set(item.id, t);
    const bytesDone = item.sizeBytes === null ? bytesSent : Math.min(bytesSent, item.sizeBytes);
    store.updateItem(item.id, { bytesDone: Math.max(0, bytesDone) });
    emitItem(item.id);
    touchJob(item.jobId);
  }

  // ---------------------------------------------------------------- provider helpers

  function throwIfAborted(ctx: RunContext): void {
    if (ctx.signal.aborted) throw new CancelError();
  }

  /** True while the host's work budget allows starting something new. A throwing budget counts as exhausted. */
  function budgetAllows(): boolean {
    if (budget === undefined) return true;
    try {
      return budget.canStartItem();
    } catch (error) {
      logger.warn('transfer: the work budget threw; treating it as exhausted', error);
      return false;
    }
  }

  /** Asks the budget before new work of this run; once refused, the run stays stopped. */
  function mayStart(ctx: RunContext): boolean {
    if (ctx.budgetStopped) return false;
    if (budgetAllows()) return true;
    logger.info(`transfer: work budget exhausted, job ${ctx.job.id} continues in the next run`);
    ctx.budgetStopped = true;
    return false;
  }

  /** Nothing more may be started in this run (canceled, paused, shut down, or out of budget). */
  function halted(ctx: RunContext): boolean {
    return ctx.signal.aborted || ctx.budgetStopped;
  }

  function call<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, ctx.retry);
  }

  async function listAll(ctx: RunContext, provider: CloudProvider, folderId: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      // A further page is new work: stop here when the budget ran out (the listing restarts next run).
      if (page > 0 && !mayStart(ctx)) throw new BudgetStop();
      const token = pageToken;
      const listing = await call(ctx, () => provider.listFolder(folderId, token));
      entries.push(...listing.entries);
      if (!listing.nextPageToken || seenTokens.has(listing.nextPageToken)) break;
      seenTokens.add(listing.nextPageToken);
      pageToken = listing.nextPageToken;
    }
    return entries;
  }

  // ---------------------------------------------------------------- idempotent creation (preset ids)

  /** Hands out one reserved destination id; refills the pool with one shared `generateIds` call at a time. */
  async function takePresetId(ctx: RunContext): Promise<string> {
    for (;;) {
      const id = ctx.idPool.shift();
      if (id !== undefined) return id;
      throwIfAborted(ctx);
      ctx.idRefill ??= (async () => {
        // Enough ids for what is still to be created in this job, in batches.
        const demand = store.countNeedingPresetId(ctx.job.id);
        const count = Math.min(PRESET_ID_BATCH, Math.max(1, demand));
        const ids = await call(ctx, () => ctx.dest.generateIds(count));
        const usable = ids.filter((value) => typeof value === 'string' && value.length > 0);
        if (usable.length === 0) throw new ItemFailure('unknown', 'the destination reserved no file ids');
        ctx.idPool.push(...usable);
      })().finally(() => {
        ctx.idRefill = undefined;
      });
      await ctx.idRefill;
    }
  }

  /** Reserves an id for the item and PERSISTS it before any create call may use it. */
  async function assignPresetId(ctx: RunContext, item: ItemRecord): Promise<string> {
    const presetId = await takePresetId(ctx);
    store.updateItem(item.id, { destPresetId: presetId });
    return presetId;
  }

  /** The object created for `presetId`, or undefined when none exists. Other failures propagate. */
  async function findByPresetId(ctx: RunContext, presetId: string): Promise<FileEntry | undefined> {
    try {
      return await call(ctx, () => ctx.dest.getFile(presetId));
    } catch (error) {
      if (asProviderError(error)?.kind === 'not_found') return undefined;
      throw error;
    }
  }

  /**
   * Runs a create call (folder, copy, upload) with the item's persisted preset id. A repeat never
   * makes a second object: a conflict means an earlier attempt created it although its response
   * was lost (or a retry repeated the call), so that object is looked up and returned.
   *
   * The one case that gets a NEW id: the conflict says the id is taken but `getFile` cannot see the
   * object (the earlier copy was moved to the trash). That id can never be used again, and nothing
   * visible exists under it, so one replacement id is reserved, persisted first, and used once.
   */
  async function createWithPreset(
    ctx: RunContext,
    item: ItemRecord,
    presetId: string,
    create: (presetId: string) => Promise<FileEntry>,
  ): Promise<FileEntry> {
    let id = presetId;
    for (let attempt = 1; ; attempt++) {
      try {
        const current = id;
        return await call(ctx, () => create(current));
      } catch (error) {
        if (!isPresetIdConflict(error)) throw error;
        const existing = await findByPresetId(ctx, id);
        if (existing) return existing;
        if (attempt >= 2) {
          throw new ItemFailure('unknown', 'the reserved destination ids are used by objects that cannot be read');
        }
        logger.info(`transfer: the reserved destination id of "${item.name}" is unusable (trashed copy), reserving a new one`);
        store.updateItem(item.id, { destPresetId: null });
        id = await assignPresetId(ctx, item);
      }
    }
  }

  /** Runs `fn` for every item through the job's limiter. Item failures are recorded, never thrown. */
  async function runAll(
    ctx: RunContext,
    items: ItemRecord[],
    fn: (item: ItemRecord) => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      items.map((item) =>
        ctx.limiter.run(async () => {
          if (ctx.signal.aborted) return;
          // Items not started for lack of budget keep their status and run in the next invocation.
          if (!mayStart(ctx)) return;
          try {
            await fn(item);
          } catch (error) {
            // Canceled work keeps its 'running'/'pending' status; finalize() turns it into 'canceled'.
            if (isCancelError(error) || ctx.signal.aborted) return;
            const message = formatError(error);
            logger.warn(`transfer: item "${item.name}" (${item.sourceId}) failed: ${message}`);
            updateItem(item, { status: 'failed', error: message, bytesDone: 0 });
          } finally {
            lastProgressEmit.delete(item.id);
          }
        }),
      ),
    );
  }

  // ---------------------------------------------------------------- phase 1: planning

  async function plan(ctx: RunContext): Promise<void> {
    const { job } = ctx;
    const created: string[] = [];
    store.transaction(() => {
      const known = new Set(store.listTopLevel(job.id).map((i) => i.sourceId));
      for (const sourceId of job.sourceFileIds) {
        if (known.has(sourceId)) continue;
        known.add(sourceId);
        const id = generateId();
        store.insertItem({ id, jobId: job.id, parentItemId: null, depth: 0, sourceId, name: sourceId });
        created.push(id);
      }
    });
    for (const id of created) emitItem(id);
    if (created.length > 0) touchJob(job.id);

    const withoutMeta = store.listSelection(job.id, 'needsMeta');
    await runAll(ctx, withoutMeta, async (item) => {
      const entry = await call(ctx, () => ctx.source.getFile(item.sourceId));
      updateItem(item, metaPatch(entry));
    });

    // Breadth-first: the whole source tree is listed before anything is created at the destination.
    for (;;) {
      if (halted(ctx)) return;
      const folders = store.listSelection(job.id, 'foldersToExpand');
      if (folders.length === 0) return;
      await runAll(ctx, folders, (item) => expandFolder(ctx, item));
    }
  }

  async function expandFolder(ctx: RunContext, item: ItemRecord): Promise<void> {
    const entries = await listAll(ctx, ctx.source, item.sourceId);
    const created: string[] = [];
    store.transaction(() => {
      const existing = new Set(store.listChildren(item.id).map((child) => child.sourceId));
      for (const entry of entries) {
        if (existing.has(entry.id) || ctx.destIds.has(entry.id)) continue;
        existing.add(entry.id);
        const child: NewItem = {
          ...metaPatch(entry),
          id: generateId(),
          jobId: item.jobId,
          parentItemId: item.id,
          depth: item.depth + 1,
          sourceId: entry.id,
          name: entry.name,
        };
        store.insertItem(child);
        created.push(child.id);
      }
      store.updateItem(item.id, { expanded: true });
    });
    for (const id of created) emitItem(id);
    touchJob(item.jobId);
  }

  // ---------------------------------------------------------------- phase 2: destination folders

  function destParentOf(ctx: RunContext, item: ItemRecord): string {
    if (item.parentItemId === null) return ctx.job.destFolderId;
    const parent = store.getItem(item.parentItemId);
    if (!parent || parent.status !== 'done' || parent.destId === null) {
      throw new ItemFailure('parent_failed', 'the destination folder for this item was not created');
    }
    return parent.destId;
  }

  async function createFolders(ctx: RunContext): Promise<void> {
    const { job } = ctx;
    for (;;) {
      if (halted(ctx)) return;
      const parents = new Map<string, ItemRecord | undefined>();
      const ready = store.listSelection(job.id, 'foldersToCreate').filter((i) => {
        if (i.parentItemId === null) return true;
        if (!parents.has(i.parentItemId)) parents.set(i.parentItemId, store.getItem(i.parentItemId));
        const parent = parents.get(i.parentItemId);
        return parent !== undefined && parent.status === 'done' && parent.destId !== null;
      });
      if (ready.length === 0) break;
      await runAll(ctx, ready, async (initial) => {
        if (initial.destId !== null) {
          // Created by an earlier run of this job: reuse it.
          updateItem(initial, { status: 'done', error: null });
          return;
        }
        const item = updateItem(initial, { status: 'running', error: null });
        const parentId = destParentOf(ctx, item);
        let entry: FileEntry | undefined;
        let presetId = item.destPresetId;
        if (presetId !== null) {
          // An earlier attempt may have created it (response lost, or the host stopped before
          // recording it): look it up by the persisted id before creating anything.
          entry = await findByPresetId(ctx, presetId);
        } else {
          presetId = await assignPresetId(ctx, item);
        }
        entry ??= await createWithPreset(ctx, item, presetId, (id) =>
          ctx.dest.createFolder(parentId, item.name, { presetId: id }),
        );
        ctx.destIds.add(entry.id);
        updateItem(item, { status: 'done', destId: entry.id, error: null });
      });
    }
    if (halted(ctx)) return;

    // Whatever is still pending below a folder that could not be created can never run.
    // Insertion order guarantees parents are visited before their children.
    for (const item of store.listSelection(job.id, 'pendingUnderUnfinishedParent')) {
      updateItem(item, {
        status: 'failed',
        error: 'parent_failed: the parent folder could not be created at the destination',
      });
    }
  }

  // ---------------------------------------------------------------- phase 3: files

  /**
   * `beforeCreate` hook of shareWithAccount: persists that a share create is about to be sent.
   * `fired()` tells whether THIS call reached the create (its lookup found no permission).
   */
  function sharePendingHook(itemId: string): { options: ShareOptions; fired: () => boolean } {
    let fired = false;
    return {
      options: {
        beforeCreate: () => {
          fired = true;
          store.updateItem(itemId, { sharePending: true });
        },
      },
      fired: () => fired,
    };
  }

  /**
   * True when `error` shows the provider ANSWERED the request with a client error (HTTP 4xx other
   * than 408): a request that was rejected did not take effect. A 5xx, a network failure or a
   * timeout leaves the outcome unknown.
   */
  function isDefiniteRejection(error: unknown): boolean {
    const status = asProviderError(error)?.status;
    return status !== undefined && status >= 400 && status < 500 && status !== 408;
  }


  /**
   * An earlier attempt created (or was about to create) a reader permission for the destination
   * account when it stopped without recording the id (`sharePending`). Any permission of that
   * account on the file is therefore this engine's own: record it, then remove it. Rejects when the
   * provider could not be asked; the mark then stays for the next sweep.
   */
  async function settlePendingShare(source: CloudProvider, item: ItemRecord, destEmail: string): Promise<boolean> {
    const hook = sharePendingHook(item.id);
    let shared: { permissionId: string; alreadyShared?: boolean };
    try {
      shared = await withRetry(() => source.shareWithAccount(item.sourceId, destEmail, hook.options), cleanupRetry);
    } catch (error) {
      // This lookup found NO permission and the create was then rejected for good: nothing was
      // created, so nothing is outstanding. Without clearing the mark it would stay set for ever, and a
      // later sweep would take a share the owner makes afterwards for ours and remove it.
      if (hook.fired() && isDefiniteRejection(error)) {
        store.updateItem(item.id, { sharePending: false });
        return false;
      }
      throw error;
    }
    store.updateItem(item.id, { permissionId: shared.permissionId, sharePending: false });
    try {
      await withRetry(() => source.unshare(item.sourceId, shared.permissionId), cleanupRetry);
    } catch (error) {
      if (asProviderError(error)?.kind !== 'not_found') throw error;
    }
    if (store.getItem(item.id)?.permissionId === shared.permissionId) store.updateItem(item.id, { permissionId: null });
    return true;
  }

  /** Removes a temporary permission. Runs to completion even after a cancel; never throws. */
  async function removePermission(ctx: RunContext, item: ItemRecord, permissionId: string): Promise<void> {
    try {
      await withRetry(() => ctx.source.unshare(item.sourceId, permissionId), cleanupRetry);
      store.updateItem(item.id, { permissionId: null });
    } catch (error) {
      // Already gone (removed by hand, or by an earlier attempt): nothing is left to clean up.
      if (asProviderError(error)?.kind === 'not_found') {
        store.updateItem(item.id, { permissionId: null });
        return;
      }
      const warning = formatError(error, 'unshare_failed');
      logger.warn(
        `transfer: could not remove temporary permission ${permissionId} from "${item.name}" (${item.sourceId}): ${warning}`,
      );
      store.updateItem(item.id, { warning });
      emitItem(item.id);
    }
  }

  async function verifyFile(ctx: RunContext, item: ItemRecord, entry: FileEntry): Promise<VerifyResult> {
    if (!entry.id) return { ok: false, detail: 'the destination reported no file id' };
    // Google-native files have no size or checksum: presence is all that can be checked.
    if (item.isGoogleNative) return { ok: true, sizeBytes: null };
    let dest = entry;
    const sizeMissing = item.sizeBytes !== null && dest.sizeBytes === null;
    const md5Missing = item.md5 !== null && dest.md5Checksum === undefined;
    if (sizeMissing || md5Missing) {
      try {
        dest = await call(ctx, () => ctx.dest.getFile(entry.id));
      } catch (error) {
        if (isCancelError(error)) throw error;
        return { ok: false, detail: `could not read the destination file (${formatError(error)})` };
      }
    }
    return compareWithSource(item, dest);
  }

  function streamTooLarge(sizeBytes: number | null, cap: number): ItemFailure {
    return new ItemFailure(
      'stream_file_too_large',
      `${sizeBytes === null ? 'the file' : `${sizeBytes} bytes`} exceeds the limit of ${cap} bytes for copying by download and upload on this host`,
    );
  }

  async function streamCopy(ctx: RunContext, item: ItemRecord, parentId: string, presetId: string): Promise<FileEntry> {
    return createWithPreset(ctx, item, presetId, async (id) => {
      // Every attempt starts from byte 0 with a fresh download.
      reportProgress(item, 0, true);
      const source = await ctx.source.downloadStream(item.sourceId);
      // With a cap, a file of unknown size is cut off before the upload can be finalized.
      let tooLarge = false;
      let seen = 0;
      const cap = maxStreamBytes;
      const body =
        cap === undefined
          ? new PassThrough()
          : new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                seen += chunk.length;
                if (seen > cap) {
                  tooLarge = true;
                  callback(streamTooLarge(item.sizeBytes, cap));
                } else {
                  callback(null, chunk);
                }
              },
            });
      let pipeError: unknown;
      const piping = pipeline(source, body, { signal: ctx.signal }).catch((error: unknown) => {
        pipeError = error;
      });
      try {
        return await ctx.dest.resumableUploadFromStream({
          parentId,
          name: item.name,
          mimeType: item.mimeType || 'application/octet-stream',
          ...(item.sizeBytes !== null ? { size: item.sizeBytes } : {}),
          stream: body,
          chunkSize,
          onProgress: (progress) => reportProgress(item, progress.bytesSent),
          presetId: id,
        });
      } catch (uploadError) {
        source.destroy();
        body.destroy();
        await piping;
        if (ctx.signal.aborted) throw new CancelError();
        if (tooLarge && cap !== undefined) throw streamTooLarge(item.sizeBytes, cap);
        // A failed download surfaces through the upload; prefer the download's own typed error.
        if (asProviderError(pipeError) && !asProviderError(uploadError)) throw pipeError;
        throw uploadError;
      } finally {
        source.destroy();
        body.destroy();
      }
    });
  }

  async function processFile(ctx: RunContext, initial: ItemRecord): Promise<void> {
    let item = updateItem(initial, { status: 'running', error: null, bytesDone: 0 });

    // A permission left behind by an interrupted earlier run.
    if (item.permissionId !== null) await removePermission(ctx, item, item.permissionId);
    throwIfAborted(ctx);

    const parentId = destParentOf(ctx, item);

    if (item.destId !== null) {
      // An earlier run produced a copy: keep it if it verifies now, otherwise copy again.
      const previousId = item.destId;
      let previous: FileEntry | undefined;
      try {
        previous = await call(ctx, () => ctx.dest.getFile(previousId));
      } catch (error) {
        // Only a copy that is really gone is replaced. Any other failure fails this attempt, so a
        // copy that merely could not be read right now is never duplicated.
        if (asProviderError(error)?.kind !== 'not_found') throw error;
      }
      if (previous && (item.isGoogleNative || compareWithSource(item, previous).ok)) {
        ctx.destIds.add(previousId);
        updateItem(item, {
          status: 'done',
          verified: true,
          error: null,
          bytesDone: item.sizeBytes ?? previous.sizeBytes ?? 0,
        });
        return;
      }
      // Gone, or different from the source: that object stays untouched (nothing is ever deleted)
      // and a new copy is made under a NEW reserved id (the old one is taken).
      item = updateItem(item, { destId: null, verified: null, destPresetId: null });
    }

    if (item.mimeType === SHORTCUT_MIME_TYPE) {
      await processShortcut(ctx, item, parentId);
      return;
    }

    if (item.sizeBytes !== null && item.sizeBytes > maxFileBytes) {
      throw new ItemFailure(
        'file_too_large',
        `${item.sizeBytes} bytes exceeds the limit of ${maxFileBytes} bytes per file`,
      );
    }

    let entry: FileEntry | undefined;
    let strategy: TransferStrategy | null = null;
    let primaryError: unknown;

    let presetId: string;
    if (item.destPresetId !== null) {
      // Resume: an earlier attempt may have created the copy although its response was lost or the
      // host stopped before recording it. Look it up by the persisted id; never reserve a second one.
      presetId = item.destPresetId;
      entry = await findByPresetId(ctx, presetId);
      if (entry) {
        strategy = item.strategyUsed;
        logger.info(`transfer: "${item.name}" was already created at the destination by an earlier attempt`);
      }
    } else {
      presetId = await assignPresetId(ctx, item);
      item = { ...item, destPresetId: presetId };
    }

    if (entry === undefined && item.canCopy) {
      if (ctx.sameAccount) {
        // Same account: plain server-side copy, nothing to share.
        store.updateItem(item.id, { strategyUsed: null });
        try {
          entry = await createWithPreset(ctx, item, presetId, (id) =>
            ctx.dest.copyWithin(item.sourceId, parentId, item.name, { presetId: id }),
          );
        } catch (error) {
          primaryError = error;
        }
      } else {
        strategy = 'permission-copy';
        store.updateItem(item.id, { strategyUsed: strategy });
        let permissionId: string | undefined;
        try {
          const shared = await call(ctx, () =>
            ctx.source.shareWithAccount(item.sourceId, ctx.destEmail, sharePendingHook(item.id).options),
          );
          // A share the owner made earlier is not ours: never record it, never remove it. But when
          // the sharePending mark is set, this call or an interrupted earlier attempt found NO share
          // and went on to create one whose response was lost: the share found now is ours.
          if (shared.alreadyShared !== true || store.getItem(item.id)?.sharePending === true) {
            permissionId = shared.permissionId;
            // Persisted before the copy so a crash cannot orphan the permission silently.
            store.updateItem(item.id, { permissionId, sharePending: false });
          }
          throwIfAborted(ctx);
          entry = await createWithPreset(ctx, item, presetId, (id) =>
            ctx.dest.copyWithin(item.sourceId, parentId, item.name, { presetId: id }),
          );
        } catch (error) {
          primaryError = error;
        } finally {
          if (permissionId !== undefined) {
            await removePermission(ctx, item, permissionId);
          } else if (store.getItem(item.id)?.sharePending === true) {
            // The share call failed after its create was sent: the create may have landed.
            try {
              await settlePendingShare(ctx.source, item, ctx.destEmail);
            } catch (error) {
              logger.warn(
                `transfer: could not check "${item.name}" (${item.sourceId}) for a temporary permission; retried by the next sweep: ${formatError(error)}`,
              );
            }
          }
        }
      }
    }

    if (entry === undefined && primaryError !== undefined) {
      if (isCancelError(primaryError) || ctx.signal.aborted) throw new CancelError();
      // The copy may have succeeded although its response was lost (a non-retryable network
      // error): the reserved id finds it, so no fallback runs for a copy that already exists.
      const reserved = store.getItem(item.id)?.destPresetId ?? presetId;
      entry = await findByPresetId(ctx, reserved);
      if (entry) logger.info(`transfer: the server-side copy of "${item.name}" exists although its call failed`);
    }

    if (entry === undefined) {
      if (isCancelError(primaryError) || ctx.signal.aborted) throw new CancelError();
      if (item.isGoogleNative) {
        throw new ItemFailure(
          'google_native_not_streamable',
          primaryError === undefined
            ? 'this Google file cannot be copied server-side and has no binary content to stream'
            : `server-side copy failed (${formatError(primaryError)}) and Google files have no binary content to stream`,
        );
      }
      if (!item.canDownload) {
        throw new ItemFailure(
          'forbidden',
          primaryError === undefined
            ? 'the file may be neither copied nor downloaded'
            : `server-side copy failed (${formatError(primaryError)}) and the file may not be downloaded`,
        );
      }
      if (primaryError !== undefined) {
        logger.info(
          `transfer: server-side copy of "${item.name}" failed (${formatError(primaryError)}), falling back to stream`,
        );
      }
      strategy = 'stream';
      store.updateItem(item.id, { strategyUsed: strategy });
      // Refused up front: nothing is downloaded and nothing is created at the destination.
      if (maxStreamBytes !== undefined && item.sizeBytes !== null && item.sizeBytes > maxStreamBytes) {
        throw streamTooLarge(item.sizeBytes, maxStreamBytes);
      }
      // A replacement id reserved by the copy attempt is the one on the row now.
      entry = await streamCopy(ctx, item, parentId, store.getItem(item.id)?.destPresetId ?? presetId);
    }

    ctx.destIds.add(entry.id);
    // Stored before verifying: a cancel during verification must not lose track of the copy.
    store.updateItem(item.id, { destId: entry.id });
    const check = await verifyFile(ctx, item, entry);
    if (check.ok) {
      const sizeBytes = item.isGoogleNative ? item.sizeBytes : (item.sizeBytes ?? check.sizeBytes);
      updateItem(item, {
        status: 'done',
        destId: entry.id,
        verified: true,
        strategyUsed: strategy,
        error: null,
        sizeBytes,
        bytesDone: sizeBytes ?? 0,
      });
    } else {
      logger.warn(`transfer: verification of "${item.name}" (${item.sourceId}) failed: ${check.detail}`);
      updateItem(item, {
        status: 'failed',
        destId: entry.id,
        verified: false,
        strategyUsed: strategy,
        error: `verification_failed: ${check.detail}`,
        bytesDone: 0,
      });
    }
  }

  async function copyFiles(ctx: RunContext): Promise<void> {
    if (halted(ctx)) return;
    // Shortcuts last: one pointing into this transfer must point at the COPY of its target, which
    // exists only once every other file is done.
    for (const phase of ['exclude', 'only'] as const) {
      if (phase === 'only' && store.countUnfinishedFiles(ctx.job.id, SHORTCUT_MIME_TYPE) > 0) return;
      // Page by page, so a job with tens of thousands of files never sits in memory at once.
      let previous = '';
      for (;;) {
        if (halted(ctx)) return;
        const page = store.listPendingFiles(ctx.job.id, COPY_PAGE_SIZE, phase, SHORTCUT_MIME_TYPE);
        if (page.length === 0) break;
        // A page that made no progress (nothing could start) is left for the next run.
        const key = page.map((i) => i.id).join(',');
        if (key === previous) return;
        previous = key;
        await runAll(ctx, page, (item) => processFile(ctx, item));
      }
    }
  }

  /**
   * A Drive shortcut is a pointer, not content: it cannot be shared or streamed, so it is recreated
   * at the destination. When its target is part of this transfer, the new shortcut points at the
   * target's copy (the original may go to the trash); otherwise at the same target, which the
   * destination account must be able to open.
   */
  async function processShortcut(ctx: RunContext, initial: ItemRecord, parentId: string): Promise<void> {
    let item = initial;
    let entry: FileEntry | undefined;
    let presetId: string;
    if (item.destPresetId !== null) {
      presetId = item.destPresetId;
      entry = await findByPresetId(ctx, presetId);
    } else {
      presetId = await assignPresetId(ctx, item);
      item = { ...item, destPresetId: presetId };
    }

    if (entry === undefined) {
      const source = await call(ctx, () => ctx.source.getFile(item.sourceId));
      const targetId = source.shortcutTargetId;
      if (targetId === undefined) {
        throw new ItemFailure('shortcut_target_unavailable', 'Google Drive reported no target for this shortcut');
      }
      let destTarget = targetId;
      const inJob = store.findBySourceId(ctx.job.id, targetId)[0];
      if (inJob !== undefined) {
        if (inJob.status !== 'done' || inJob.destId === null) {
          throw new ItemFailure(
            'shortcut_target_unavailable',
            `the target "${inJob.name}" is part of this transfer but was not copied`,
          );
        }
        destTarget = inJob.destId;
      }
      store.updateItem(item.id, { strategyUsed: null });
      try {
        entry = await createWithPreset(ctx, item, presetId, (id) =>
          ctx.dest.createShortcut(parentId, item.name, destTarget, { presetId: id }),
        );
      } catch (error) {
        if (isCancelError(error)) throw error;
        if (ctx.signal.aborted) throw new CancelError();
        const kind = asProviderError(error)?.kind;
        if (kind === 'not_found' || kind === 'forbidden') {
          throw new ItemFailure(
            'shortcut_target_unavailable',
            `the destination account cannot open the shortcut's target (${formatError(error)})`,
          );
        }
        throw error;
      }
    }

    ctx.destIds.add(entry.id);
    store.updateItem(item.id, { destId: entry.id });
    const ok = entry.mimeType === SHORTCUT_MIME_TYPE;
    updateItem(item, {
      status: ok ? 'done' : 'failed',
      destId: entry.id,
      verified: ok,
      strategyUsed: null,
      error: ok ? null : 'verification_failed: the destination object is not a shortcut',
      bytesDone: 0,
    });
  }

  // ---------------------------------------------------------------- phase 4: verification

  async function verifyFolder(ctx: RunContext, item: ItemRecord): Promise<void> {
    const children = store.listChildren(item.id);
    if (!children.every((child) => child.status === 'done' && child.verified === true)) {
      // The failing child carries the reason; the folder itself was created fine.
      updateItem(item, { verified: false });
      return;
    }
    const destId = item.destId;
    if (destId === null) {
      updateItem(item, { status: 'failed', verified: false, error: 'verification_failed: no destination folder' });
      return;
    }
    let sourceEntries: FileEntry[];
    let destEntries: FileEntry[];
    try {
      sourceEntries = (await listAll(ctx, ctx.source, item.sourceId)).filter((e) => !ctx.destIds.has(e.id));
      destEntries = await listAll(ctx, ctx.dest, destId);
    } catch (error) {
      if (isCancelError(error)) throw error;
      updateItem(item, { status: 'failed', verified: false, error: formatError(error, 'verification_failed') });
      return;
    }
    const sourceIds = new Set(sourceEntries.map((e) => e.id));
    const copiedSourceIds = new Set(children.map((child) => child.sourceId));
    const destIds = new Set(destEntries.map((e) => e.id));
    const present = children.filter((child) => child.destId !== null && destIds.has(child.destId)).length;
    const sameChildren =
      sourceIds.size === copiedSourceIds.size && [...sourceIds].every((id) => copiedSourceIds.has(id));
    if (sameChildren && present === children.length) {
      updateItem(item, { verified: true, error: null });
      return;
    }
    updateItem(item, {
      status: 'failed',
      verified: false,
      error: `verification_failed: source folder has ${sourceIds.size} children, ${present} of ${children.length} copied items are present at the destination`,
    });
  }

  async function verifyFolders(ctx: RunContext): Promise<void> {
    const folders = store.listSelection(ctx.job.id, 'foldersToVerify');
    // Deepest first, so a parent sees the final verdict of its sub-folders.
    const depths = [...new Set(folders.map((f) => f.depth))].sort((a, b) => b - a);
    for (const depth of depths) {
      if (halted(ctx)) return;
      await runAll(
        ctx,
        folders.filter((f) => f.depth === depth),
        (item) => verifyFolder(ctx, item),
      );
    }
  }

  // ---------------------------------------------------------------- phase 5: trash (move only)

  /** Returns the job-level reason when the sources were not (all) trashed, else `undefined`. */
  async function trashSources(ctx: RunContext): Promise<string | undefined> {
    const { job } = ctx;
    if (job.mode !== 'move') return undefined;
    if (job.confirmMove !== true) return 'move_not_confirmed: the move was not confirmed; nothing was moved to trash';
    if (halted(ctx)) return undefined;

    const items = store.listItemsLite(job.id);
    if (items.length === 0) return 'move_not_verified: nothing was copied; nothing was moved to trash';

    // Each selected top-level source is judged on its OWN subtree: it goes to the trash only when
    // it and everything copied below it is done and verified. One uncopyable file elsewhere in the
    // selection must not keep every other (fully copied) source in place.
    const children = new Map<string, ItemLite[]>();
    for (const item of items) {
      if (item.parentItemId === null) continue;
      const list = children.get(item.parentItemId) ?? [];
      list.push(item);
      children.set(item.parentItemId, list);
    }
    const subtreeVerified = (root: ItemLite): boolean => {
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop() as ItemLite;
        if (node.status !== 'done' || node.verified !== true) return false;
        stack.push(...(children.get(node.id) ?? []));
      }
      return true;
    };
    const topLevel = items.filter((i) => i.parentItemId === null);
    const blocked = topLevel.filter((i) => !i.sourceTrashed && !subtreeVerified(i));
    const unverified = items.filter((i) => i.status !== 'done' || i.verified !== true).length;
    const notVerifiedNote =
      blocked.length > 0
        ? `move_not_verified: ${blocked.length} of ${topLevel.length} selected items (${unverified} items in total) were not fully copied and verified; their originals were kept in place`
        : undefined;

    const verifiedIds = new Set(topLevel.filter((i) => !i.sourceTrashed && subtreeVerified(i)).map((i) => i.id));
    const sources = store.listTopLevel(job.id).filter((i) => verifiedIds.has(i.id));
    let failures = 0;
    for (const item of sources) {
      if (ctx.signal.aborted) return undefined;
      // Out of budget: the remaining sources are trashed in the next run (sourceTrashed is persisted).
      if (!mayStart(ctx)) return undefined;
      try {
        await call(ctx, () => ctx.source.trash(item.sourceId));
        updateItem(item, { sourceTrashed: true, warning: null });
      } catch (error) {
        if (isCancelError(error)) return undefined;
        failures++;
        const warning = formatError(error, 'trash_failed');
        logger.warn(`transfer: could not move "${item.name}" (${item.sourceId}) to the trash: ${warning}`);
        updateItem(item, { warning });
      }
    }
    if (failures > 0) {
      return `trash_failed: ${failures} of ${sources.length} sources could not be moved to trash (their copies are complete)`;
    }
    return notVerifiedNote;
  }

  // ---------------------------------------------------------------- job lifecycle

  /**
   * Persists the outcome of a run. Returns true when the run was only PAUSED (host pause or work
   * budget exhausted): the job is back to 'queued' and its unfinished items are pending.
   */
  function finalize(
    jobId: string,
    signal: AbortSignal,
    fatal: string | undefined,
    note: string | undefined,
    budgetStopped = false,
  ): boolean {
    clearJobTimer(jobId);
    lastJobEmit.delete(jobId);
    const changed: string[] = [];
    let status: TransferJobStatus = 'failed';
    let error: string | null = null;
    let paused = false;

    store.transaction(() => {
      const job = store.getJob(jobId);
      const closeLeftovers = (itemStatus: 'failed' | 'canceled', message: string): void => {
        for (const item of store.listSelection(jobId, 'unfinished')) {
          store.updateItem(item.id, { status: itemStatus, error: message, bytesDone: 0 });
          changed.push(item.id);
        }
      };

      const pausedByHost = signal.aborted && signal.reason === PAUSE;
      const pausedByBudget = !signal.aborted && fatal === undefined && budgetStopped;
      if (pausedByHost || pausedByBudget) {
        // Not an outcome: the host ran out of time or budget. Unfinished items wait for the next run.
        for (const item of store.listSelection(jobId, 'running')) {
          store.updateItem(item.id, { status: 'pending', bytesDone: 0 });
          changed.push(item.id);
        }
        store.updateJob(jobId, { status: 'queued' });
        paused = true;
        return;
      }
      if (signal.aborted && signal.reason === SHUTDOWN) {
        closeLeftovers('failed', 'interrupted');
        status = 'failed';
        error = 'interrupted';
      } else if (signal.aborted) {
        closeLeftovers('canceled', 'canceled');
        status = 'canceled';
        error = 'canceled';
      } else if (fatal !== undefined) {
        closeLeftovers('failed', fatal);
        status = 'failed';
        error = fatal;
      } else {
        closeLeftovers('failed', 'unknown: the item was not processed');
        const fresh = store.listItemsLite(jobId);
        const done = fresh.filter((i) => i.status === 'done').length;
        const allVerified = fresh.every((i) => i.status === 'done' && i.verified === true);
        if (fresh.length === 0) {
          status = 'failed';
          error = 'unknown: nothing to transfer';
        } else if (done === 0) {
          status = 'failed';
          error = store.listSelection(jobId, 'firstError')[0]?.error ?? 'unknown';
        } else if (!allVerified) {
          status = 'completed_with_errors';
          error = note ?? null;
        } else if (job?.mode === 'move') {
          const allTrashed = fresh.filter((i) => i.parentItemId === null).every((i) => i.sourceTrashed);
          status = allTrashed ? 'completed' : 'completed_with_errors';
          error = allTrashed ? null : (note ?? 'trash_failed');
        } else {
          status = 'completed';
        }
      }
      store.updateJob(jobId, { status, error, finishedAt: isoNow() });
    });

    for (const id of changed) emitItem(id);
    if (paused) {
      logger.info(`transfer: job ${jobId} paused, it resumes on the next run`);
      emitJobNow(jobId);
      return true;
    }
    const record = store.getJob(jobId);
    if (record) {
      logger.info(`transfer: job ${jobId} finished with status ${record.status}${record.error ? ` (${record.error})` : ''}`);
      emit({ type: 'job.finished', payload: { job: jobView(record, false) } });
    }
    return false;
  }

  /** Runs one job until it finishes or pauses. Resolves true when it paused (it goes back in the queue). */
  async function runJob(jobId: string, ctl: AbortController): Promise<boolean> {
    const job = store.getJob(jobId);
    if (!job) return false;
    const signal = ctl.signal;
    let fatal: string | undefined;
    let note: string | undefined;
    let ctx: RunContext | undefined;
    try {
      setJob(jobId, { status: 'running' });
      logger.info(`transfer: job ${jobId} started (${job.mode}, ${job.sourceFileIds.length} selected)`);
      const sameAccount = job.sourceAccountId === job.destAccountId;
      const source = await deps.resolveProvider(job.sourceAccountId);
      const dest = sameAccount ? source : await deps.resolveProvider(job.destAccountId);
      const destEmail = sameAccount ? '' : deps.getAccountEmail(job.destAccountId);
      ctx = {
        job,
        signal,
        source,
        dest,
        sameAccount,
        destEmail,
        limiter: createLimiter(itemConcurrency),
        retry: {
          policy,
          sleep,
          random,
          signal,
          onRetry: ({ attempt, delayMs, error }) =>
            logger.info(`transfer: attempt ${attempt} failed (${formatError(error)}), retrying in ${delayMs} ms`),
        },
        destIds: new Set(store.listDestIds(jobId)),
        idPool: [],
        idRefill: undefined,
        budgetStopped: false,
      };

      await plan(ctx);
      if (!halted(ctx)) await createFolders(ctx);
      if (!halted(ctx)) await copyFiles(ctx);
      if (!halted(ctx)) {
        setJob(jobId, { status: 'verifying' });
        await verifyFolders(ctx);
      }
      if (!halted(ctx)) note = await trashSources(ctx);
    } catch (error) {
      if (!isCancelError(error)) {
        fatal = formatError(error);
        logger.error(`transfer: job ${jobId} failed: ${fatal}`);
      }
    }
    try {
      return finalize(jobId, signal, fatal, note, ctx?.budgetStopped === true);
    } catch (error) {
      logger.error(`transfer: could not persist the final state of job ${jobId}`, error);
      return false;
    }
  }

  /** Something may still start in this invocation. */
  function canStartMore(): boolean {
    return !closed && (!manual || gateOpen) && budgetAllows();
  }

  /** Nothing is running and nothing more will start in this invocation. */
  function isIdle(): boolean {
    return running.size === 0 && (queue.length === 0 || !canStartMore());
  }

  function resolveIdleWaiters(): void {
    if (isIdle()) for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function notifyFinished(jobId: string): void {
    const waiters = finishWaiters.get(jobId);
    finishWaiters.delete(jobId);
    for (const resolve of waiters ?? []) resolve();
    resolveIdleWaiters();
  }

  function pump(): void {
    while (!closed && (!manual || gateOpen) && running.size < jobConcurrency) {
      // An exhausted work budget starts no job; the host starts the engine again in its next run.
      if (queue.length === 0 || !budgetAllows()) return;
      const jobId = queue.shift();
      if (jobId === undefined) return;
      const ctl = new AbortController();
      const promise = runJob(jobId, ctl)
        .catch((error: unknown) => {
          logger.error(`transfer: job ${jobId} crashed`, error);
          return false;
        })
        .then((paused) => {
          running.delete(jobId);
          // A paused job goes back to the head of the queue for the next run.
          if ((paused || (ctl.signal.aborted && ctl.signal.reason === PAUSE)) && !closed) queue.unshift(jobId);
          notifyFinished(jobId);
          pump();
        });
      running.set(jobId, { ctl, promise });
    }
  }

  function enqueue(jobId: string): void {
    queue.push(jobId);
    // Manual mode: only the host's own invocation (start(), or a job finishing) starts jobs.
    if (manual) return;
    // Deferred so the caller gets its 'queued' snapshot (and `job.created`) before the run starts.
    queueMicrotask(pump);
  }

  function requireJob(id: string): JobRecord {
    const job = store.getJob(id);
    if (!job) throw new TransferError('not_found', `transfer job ${id} does not exist`);
    return job;
  }

  /** Same-account requests can point the destination at (or into) a source; that must never run. */
  async function preflightSameAccount(req: CreateTransferRequest): Promise<void> {
    const provider = await deps.resolveProvider(req.sourceAccountId);
    const retry: RetryContext = { policy, sleep: (ms) => sleep(ms), random };
    const selected = new Set(req.sourceFileIds);

    // The destination folder and all its ancestors, with the 'root' alias resolved to real ids.
    const destChain = new Set<string>([req.destFolderId]);
    let destRealId: string | undefined;
    let cursor: string | undefined = req.destFolderId;
    for (let depth = 0; cursor !== undefined && depth < MAX_ANCESTOR_DEPTH; depth++) {
      const id: string = cursor;
      const entry = await withRetry(() => provider.getFile(id), retry);
      if (depth === 0) destRealId = entry.id;
      destChain.add(entry.id);
      const parent: string | undefined = entry.parents[0];
      cursor = parent !== undefined && !destChain.has(parent) ? parent : undefined;
    }

    for (const sourceId of selected) {
      if (destChain.has(sourceId)) {
        throw new TransferError(
          'dest_inside_source',
          'the destination folder is the selected folder itself or lies inside it',
        );
      }
    }
    if (req.mode !== 'move') return;
    for (const sourceId of selected) {
      const entry = await withRetry(() => provider.getFile(sourceId), retry);
      if (entry.parents.includes(req.destFolderId) || (destRealId !== undefined && entry.parents.includes(destRealId))) {
        throw new TransferError(
          'same_folder_move',
          `"${entry.name}" is already in the destination folder; moving it there would only trash it`,
        );
      }
    }
  }
  // ---------------------------------------------------------------- orphaned permissions

  let sweeping: Promise<number> | null = null;

  async function sweepOrphanPermissions(): Promise<number> {
    let removed = 0;
    for (const { item, sourceAccountId, destAccountId } of store.listPendingPermissions()) {
      if (closed) break;
      const permissionId = item.permissionId;
      // A job that is queued or running handles its own permissions.
      if (running.has(item.jobId) || queue.includes(item.jobId)) continue;
      if (permissionId === null) {
        if (!item.sharePending) continue;
        // A share create whose response was lost (or never sent) by a run that then stopped.
        let destEmail: string;
        try {
          destEmail = deps.getAccountEmail(destAccountId);
        } catch {
          // The destination account was removed: its address is unknown, nothing can be matched.
          logger.warn(
            `transfer: "${item.name}" (${item.sourceId}) may still be shared with a removed account; check its sharing settings`,
          );
          store.updateItem(item.id, { sharePending: false });
          continue;
        }
        try {
          const provider = await deps.resolveProvider(sourceAccountId);
          if (await settlePendingShare(provider, item, destEmail)) removed++;
        } catch (error) {
          if (asProviderError(error)?.kind === 'not_found') {
            store.updateItem(item.id, { sharePending: false, permissionId: null });
          } else {
            logger.warn(
              `transfer: could not check "${item.name}" (${item.sourceId}) for a leftover temporary permission; retried at the next sweep: ${formatError(error)}`,
            );
          }
        }
        continue;
      }
      try {
        const provider = await deps.resolveProvider(sourceAccountId);
        await withRetry(() => provider.unshare(item.sourceId, permissionId), cleanupRetry);
      } catch (error) {
        // not_found: the permission (or the whole account) no longer exists, nothing is left to remove.
        if (asProviderError(error)?.kind !== 'not_found') {
          logger.warn(
            `transfer: could not remove leftover temporary permission ${permissionId} from "${item.name}" (${item.sourceId}); it stays recorded and is retried at the next start: ${formatError(error)}`,
          );
          continue;
        }
      }
      if (store.getItem(item.id)?.permissionId === permissionId) {
        store.updateItem(item.id, { permissionId: null });
        removed++;
      }
    }
    if (removed > 0) logger.info(`transfer: removed ${removed} leftover temporary permission(s) from an earlier run`);
    return removed;
  }

  // ---------------------------------------------------------------- public API

  const engine: TransferEngineHandle = {
    async createJob(req) {
      if (closed) throw new TransferError('engine_closed', 'the transfer engine is shut down');
      if (req !== null && typeof req === 'object' && req.mode === 'move' && req.confirmMove !== true) {
        throw new TransferError('move_not_confirmed', 'move requires confirmMove === true');
      }
      const invalid =
        req === null || typeof req !== 'object' ? 'request body is required' : validateCreateTransferRequest(req);
      if (invalid !== null) throw new TransferError('bad_request', invalid);
      if (!req.sourceFileIds.every((id) => typeof id === 'string' && id.length > 0)) {
        throw new TransferError('bad_request', 'sourceFileIds must be non-empty strings');
      }
      const sourceFileIds = [...new Set(req.sourceFileIds)];
      const normalized: CreateTransferRequest = { ...req, sourceFileIds };
      if (req.sourceAccountId === req.destAccountId) await preflightSameAccount(normalized);
      if (closed) throw new TransferError('engine_closed', 'the transfer engine is shut down');

      const record: JobRecord = {
        id: generateId(),
        mode: req.mode,
        sourceAccountId: req.sourceAccountId,
        destAccountId: req.destAccountId,
        destFolderId: req.destFolderId,
        sourceFileIds,
        confirmMove: req.confirmMove === true,
        status: 'queued',
        error: null,
        createdAt: isoNow(),
        finishedAt: null,
      };
      store.insertJob(record);
      const snapshot = jobView(record, true);
      emit({ type: 'job.created', payload: { job: jobView(record, false) } });
      enqueue(record.id);
      return snapshot;
    },

    listJobs() {
      return store.listJobs().map((record) => jobView(record, false));
    },

    getJob(id) {
      const record = store.getJob(id);
      return record ? jobView(record, true) : undefined;
    },

    async cancel(id) {
      const job = requireJob(id);
      if (isTerminalJobStatus(job.status)) return jobView(job, true);
      const active = running.get(id);
      if (active) {
        if (!active.ctl.signal.aborted) active.ctl.abort(CANCEL);
        // In-flight provider calls cannot be interrupted; wait for them and for the cleanup.
        await active.promise;
      } else {
        const index = queue.indexOf(id);
        if (index >= 0) queue.splice(index, 1);
        finalize(id, AbortSignal.abort(CANCEL), undefined, undefined, false);
        notifyFinished(id);
      }
      return jobView(requireJob(id), true);
    },

    async retryFailed(id) {
      if (closed) throw new TransferError('engine_closed', 'the transfer engine is shut down');
      const job = requireJob(id);
      if (!isTerminalJobStatus(job.status)) {
        throw new TransferError('job_not_finished', `transfer job ${id} is still ${job.status}`);
      }
      if (job.status === 'completed') return jobView(job, true);

      const changed: string[] = [];
      store.transaction(() => {
        const items = store.listItemsLite(id);
        const byId = new Map(items.map((i) => [i.id, i]));
        const topLevelTrashed = (item: ItemLite): boolean => {
          let current: ItemLite | undefined = item;
          while (current && current.parentItemId !== null) current = byId.get(current.parentItemId);
          return current?.sourceTrashed === true;
        };
        for (const item of items) {
          if (item.status === 'failed' || item.status === 'canceled') {
            const patch: ItemPatch = { status: 'pending', error: null, bytesDone: 0 };
            if (item.isFolder) {
              // List the folder again: its content may have changed since the first attempt.
              patch.expanded = false;
              patch.verified = null;
            }
            store.updateItem(item.id, patch);
            changed.push(item.id);
          } else if (item.isFolder && item.status === 'done' && !topLevelTrashed(item)) {
            // Verification is repeated for every folder whose source still exists.
            store.updateItem(item.id, { verified: null });
            changed.push(item.id);
          }
        }
        store.updateJob(id, { status: 'queued', error: null, finishedAt: null });
      });
      for (const itemId of changed) emitItem(itemId);
      emitJobNow(id);
      const snapshot = jobView(requireJob(id), true);
      enqueue(id);
      return snapshot;
    },

    async purgeTrashedSources(id, purgeOptions) {
      if (closed) throw new TransferError('engine_closed', 'the transfer engine is shut down');
      const job = requireJob(id);
      if (job.mode !== 'move') throw new TransferError('bad_request', `transfer job ${id} is not a move`);
      if (!isTerminalJobStatus(job.status) || running.has(id) || queue.includes(id)) {
        throw new TransferError('job_not_finished', `transfer job ${id} is still ${job.status}`);
      }
      const maxItems = Math.max(1, Math.floor(purgeOptions?.maxItems ?? 100));
      const isCandidate = (item: ItemRecord): boolean =>
        item.sourceTrashed && !item.sourcePurged && !(item.warning ?? '').startsWith('purge_skipped');
      const candidates = store.listTopLevel(id).filter(isCandidate);
      const batch = candidates.slice(0, maxItems);
      let purged = 0;
      let skipped = 0;
      let failed = 0;
      const source = await deps.resolveProvider(job.sourceAccountId);
      const dest = job.sourceAccountId === job.destAccountId ? source : await deps.resolveProvider(job.destAccountId);
      const limiter = createLimiter(itemConcurrency);
      const skip = (item: ItemRecord, detail: string): void => {
        skipped++;
        logger.warn(`transfer: not deleting "${item.name}" (${item.sourceId}) forever: ${detail}`);
        store.updateItem(item.id, { warning: `purge_skipped: ${detail}` });
        emitItem(item.id);
      };
      await Promise.all(
        batch.map((item) =>
          limiter.run(async () => {
            if (closed) return;
            // The copy must still be there: never free the space of an original whose copy is gone.
            const destId = item.destId;
            if (destId === null) return skip(item, 'no destination copy is recorded');
            try {
              await withRetry(() => dest.getFile(destId), cleanupRetry);
            } catch (error) {
              if (asProviderError(error)?.kind === 'not_found') {
                return skip(item, 'the destination copy is missing or in the trash');
              }
              failed++;
              store.updateItem(item.id, { warning: formatError(error, 'purge_failed') });
              emitItem(item.id);
              return;
            }
            try {
              await withRetry(() => source.deleteTrashedForever(item.sourceId), cleanupRetry);
            } catch (error) {
              if (asProviderError(error)?.code === PROVIDER_ERROR_CODES.notTrashed) {
                // Restored by the user: it is no longer in the trash and stays where it is.
                store.updateItem(item.id, { sourceTrashed: false });
                return skip(item, 'the original was restored from the trash');
              }
              failed++;
              store.updateItem(item.id, { warning: formatError(error, 'purge_failed') });
              emitItem(item.id);
              return;
            }
            purged++;
            store.updateItem(item.id, { sourcePurged: true, warning: null });
            emitItem(item.id);
          }),
        ),
      );
      logger.info(`transfer: job ${id}: ${purged} trashed source(s) deleted forever, ${skipped} skipped, ${failed} failed`);
      const remaining = store.listTopLevel(id).filter(isCandidate).length;
      emitJobNow(id);
      return { job: jobView(requireJob(id), false), purged, skipped, failed, remaining };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async waitForJob(id) {
      for (;;) {
        const job = requireJob(id);
        if (isTerminalJobStatus(job.status)) return jobView(job, true);
        if (closed && !running.has(id)) return jobView(job, true);
        await new Promise<void>((resolve) => {
          const waiters = finishWaiters.get(id) ?? [];
          waiters.push(resolve);
          finishWaiters.set(id, waiters);
        });
      }
    },

    async whenIdle() {
      while (!isIdle()) {
        if (closed && running.size === 0) return;
        await new Promise<void>((resolve) => idleWaiters.push(resolve));
      }
    },

    cleanupOrphanPermissions() {
      sweeping ??= sweepOrphanPermissions()
        .catch((error: unknown) => {
          logger.warn('transfer: cleanup of leftover temporary permissions failed', error);
          return 0;
        })
        .finally(() => {
          sweeping = null;
        });
      return sweeping;
    },

    start() {
      if (closed) return;
      gateOpen = true;
      pump();
    },

    async pause() {
      gateOpen = false;
      for (const { ctl } of running.values()) {
        if (!ctl.signal.aborted) ctl.abort(PAUSE);
      }
      await Promise.all([...running.values()].map((job) => job.promise));
      if (sweeping !== null) await sweeping;
      resolveIdleWaiters();
    },

    hasWork() {
      return queue.length > 0 || running.size > 0;
    },

    async close() {
      if (!closed) {
        closed = true;
        queue.length = 0;
        for (const { ctl } of running.values()) {
          if (!ctl.signal.aborted) ctl.abort(SHUTDOWN);
        }
      }
      await Promise.all([...running.values()].map((job) => job.promise));
      if (sweeping !== null) await sweeping;
      for (const jobId of [...jobTimers.keys()]) clearJobTimer(jobId);
      for (const waiters of finishWaiters.values()) for (const resolve of waiters) resolve();
      finishWaiters.clear();
      for (const resolve of idleWaiters.splice(0)) resolve();
      listeners.clear();
    },
  };

  // A crash while a temporary permission existed leaves it on the source file: remove it now.
  // (In manual mode the host calls this from an invocation that may do I/O.)
  if (!manual) void engine.cleanupOrphanPermissions();

  return engine;
}
