/**
 * The small synchronous SQL surface the store needs. Two hosts implement it: better-sqlite3 on
 * Node (`fromBetterSqlite`) and a Durable Object's `ctx.storage.sql` on Cloudflare.
 * Statements use positional `?` parameters only.
 */
export interface SqlDb {
  /** Runs one or more statements without parameters (schema setup). */
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** Runs `fn` atomically; `fn` must be synchronous. */
  transaction<T>(fn: () => T): T;
}

export function isSqlDb(value: unknown): value is SqlDb {
  const v = value as Partial<SqlDb> | null;
  return typeof v === 'object' && v !== null && typeof v.run === 'function' && typeof v.all === 'function'
    && typeof v.get === 'function' && typeof v.transaction === 'function' && typeof v.exec === 'function';
}
import type {
  TransferItemStatus,
  TransferJobStatus,
  TransferMode,
  TransferStrategy,
  TransferTotals,
} from '@multicloud/shared';

/** Internal view of a persisted job (superset of the shared TransferJob). */
export interface JobRecord {
  id: string;
  mode: TransferMode;
  sourceAccountId: string;
  destAccountId: string;
  destFolderId: string;
  sourceFileIds: string[];
  confirmMove: boolean;
  status: TransferJobStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Internal view of a persisted item (superset of the shared TransferItem). */
export interface ItemRecord {
  id: string;
  jobId: string;
  /** `null` for the top-level selected sources. */
  parentItemId: string | null;
  depth: number;
  sourceId: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  isGoogleNative: boolean;
  /** `null` when the provider reported no size. */
  sizeBytes: number | null;
  md5: string | null;
  canCopy: boolean;
  canDownload: boolean;
  /** False while only the source id is known (metadata not fetched yet). */
  metaLoaded: boolean;
  /** Folders only: true once the children were listed and inserted as items. */
  expanded: boolean;
  status: TransferItemStatus;
  strategyUsed: TransferStrategy | null;
  error: string | null;
  warning: string | null;
  destId: string | null;
  verified: boolean | null;
  bytesDone: number;
  /** Temporary reader permission that still has to be removed from the source file. */
  permissionId: string | null;
  /**
   * Set (persisted) right before `shareWithAccount` creates a reader permission for the destination
   * account, i.e. after its listing found none. While set, a permission of the destination account
   * on the source file was created by this engine even if its response was lost (crash, network),
   * so it is removed like any temporary permission instead of being taken for the owner's share.
   * Cleared once the permission id is recorded or the permission is gone.
   */
  sharePending: boolean;
  /** Move jobs: the top-level source was moved to the trash. */
  sourceTrashed: boolean;
  /** Move jobs: the trashed top-level source was then deleted forever (explicit purge). */
  sourcePurged: boolean;
  /**
   * Destination id reserved through `generateIds` and persisted BEFORE the create call
   * (copyWithin / createFolder / resumableUploadFromStream). Non-null means a create MAY have
   * happened at the destination with that id, so a resumed run looks it up before creating.
   */
  destPresetId: string | null;
}

/** The columns of an item that whole-job decisions (trash gate, final status, retry) need. */
export interface ItemLite {
  id: string;
  parentItemId: string | null;
  isFolder: boolean;
  status: TransferItemStatus;
  verified: boolean | null;
  sourceTrashed: boolean;
  hasError: boolean;
}

/** Named item selections; each is a fixed WHERE clause, so callers never build SQL. */
export type ItemSelection =
  | 'needsMeta'
  | 'foldersToExpand'
  | 'foldersToCreate'
  | 'foldersToVerify'
  | 'running'
  | 'unfinished'
  | 'pendingUnderUnfinishedParent'
  | 'firstError';

export type NewItem = Pick<ItemRecord, 'id' | 'jobId' | 'parentItemId' | 'depth' | 'sourceId' | 'name'> &
  Partial<Omit<ItemRecord, 'id' | 'jobId' | 'parentItemId' | 'depth' | 'sourceId' | 'name'>>;

export type ItemPatch = Partial<Omit<ItemRecord, 'id' | 'jobId'>>;
export type JobPatch = Partial<Pick<JobRecord, 'status' | 'error' | 'finishedAt'>>;

interface JobRow {
  id: string;
  mode: string;
  source_account_id: string;
  dest_account_id: string;
  dest_folder_id: string;
  source_file_ids: string;
  confirm_move: number;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface ItemRow {
  id: string;
  job_id: string;
  parent_item_id: string | null;
  depth: number;
  source_id: string;
  name: string;
  mime_type: string;
  is_folder: number;
  is_google_native: number;
  size_bytes: number | null;
  md5: string | null;
  can_copy: number;
  can_download: number;
  meta_loaded: number;
  expanded: number;
  status: string;
  strategy_used: string | null;
  error: string | null;
  warning: string | null;
  dest_id: string | null;
  verified: number | null;
  bytes_done: number;
  permission_id: string | null;
  source_trashed: number;
  source_purged: number | null;
  dest_preset_id: string | null;
  share_pending: number | null;
}

interface TotalsRow {
  items: number;
  done: number | null;
  failed: number | null;
  bytes_total: number | null;
  bytes_done: number | null;
}

export type SqlValue = string | number | null;

const ITEM_COLUMNS: Record<keyof Omit<ItemRecord, 'id' | 'jobId'>, string> = {
  parentItemId: 'parent_item_id',
  depth: 'depth',
  sourceId: 'source_id',
  name: 'name',
  mimeType: 'mime_type',
  isFolder: 'is_folder',
  isGoogleNative: 'is_google_native',
  sizeBytes: 'size_bytes',
  md5: 'md5',
  canCopy: 'can_copy',
  canDownload: 'can_download',
  metaLoaded: 'meta_loaded',
  expanded: 'expanded',
  status: 'status',
  strategyUsed: 'strategy_used',
  error: 'error',
  warning: 'warning',
  destId: 'dest_id',
  verified: 'verified',
  bytesDone: 'bytes_done',
  permissionId: 'permission_id',
  sharePending: 'share_pending',
  sourceTrashed: 'source_trashed',
  sourcePurged: 'source_purged',
  destPresetId: 'dest_preset_id',
};

const JOB_COLUMNS: Record<keyof JobPatch, string> = {
  status: 'status',
  error: 'error',
  finishedAt: 'finished_at',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfer_jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  dest_account_id TEXT NOT NULL,
  dest_folder_id TEXT NOT NULL,
  source_file_ids TEXT NOT NULL,
  confirm_move INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS transfer_items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  parent_item_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  is_folder INTEGER NOT NULL DEFAULT 0,
  is_google_native INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  md5 TEXT,
  can_copy INTEGER NOT NULL DEFAULT 0,
  can_download INTEGER NOT NULL DEFAULT 0,
  meta_loaded INTEGER NOT NULL DEFAULT 0,
  expanded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  strategy_used TEXT,
  error TEXT,
  warning TEXT,
  dest_id TEXT,
  verified INTEGER,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  permission_id TEXT,
  source_trashed INTEGER NOT NULL DEFAULT 0,
  dest_preset_id TEXT,
  share_pending INTEGER NOT NULL DEFAULT 0,
  source_purged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS transfer_items_job_idx ON transfer_items (job_id);
CREATE INDEX IF NOT EXISTS transfer_items_parent_idx ON transfer_items (parent_item_id);
`;

/**
 * Columns added after the first release, as [table, column, definition]. CREATE TABLE IF NOT EXISTS
 * does not touch an existing table, so each one is added by a guarded ALTER TABLE. The probe is a
 * plain SELECT because Durable Object SQLite does not allow every PRAGMA (e.g. user_version).
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ['transfer_items', 'dest_preset_id', 'TEXT'],
  ['transfer_items', 'share_pending', 'INTEGER NOT NULL DEFAULT 0'],
  ['transfer_items', 'source_purged', 'INTEGER NOT NULL DEFAULT 0'],
];

function hasColumn(db: SqlDb, table: string, column: string): boolean {
  try {
    db.all(`SELECT ${column} FROM ${table} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/** Brings a database created by an older version up to the current schema. Idempotent. */
function migrate(db: SqlDb): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    if (hasColumn(db, table, column)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      // Another engine instance on the same database may have added it in the meantime.
      if (!hasColumn(db, table, column)) throw error;
    }
  }
}

function toSql(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

function jobFromRow(row: JobRow): JobRecord {
  let sourceFileIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.source_file_ids);
    if (Array.isArray(parsed)) sourceFileIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    sourceFileIds = [];
  }
  return {
    id: row.id,
    mode: row.mode as TransferMode,
    sourceAccountId: row.source_account_id,
    destAccountId: row.dest_account_id,
    destFolderId: row.dest_folder_id,
    sourceFileIds,
    confirmMove: row.confirm_move === 1,
    status: row.status as TransferJobStatus,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function itemFromRow(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    parentItemId: row.parent_item_id,
    depth: row.depth,
    sourceId: row.source_id,
    name: row.name,
    mimeType: row.mime_type,
    isFolder: row.is_folder === 1,
    isGoogleNative: row.is_google_native === 1,
    sizeBytes: row.size_bytes,
    md5: row.md5,
    canCopy: row.can_copy === 1,
    canDownload: row.can_download === 1,
    metaLoaded: row.meta_loaded === 1,
    expanded: row.expanded === 1,
    status: row.status as TransferItemStatus,
    strategyUsed: row.strategy_used as TransferStrategy | null,
    error: row.error,
    warning: row.warning,
    destId: row.dest_id,
    verified: row.verified === null ? null : row.verified === 1,
    bytesDone: row.bytes_done,
    permissionId: row.permission_id,
    sharePending: row.share_pending === 1,
    sourceTrashed: row.source_trashed === 1,
    sourcePurged: row.source_purged === 1,
    destPresetId: row.dest_preset_id ?? null,
  };
}

export interface TransferStore {
  transaction<T>(fn: () => T): T;
  insertJob(job: JobRecord): void;
  getJob(id: string): JobRecord | undefined;
  /** Newest first. */
  listJobs(): JobRecord[];
  updateJob(id: string, patch: JobPatch): void;
  insertItem(item: NewItem): void;
  getItem(id: string): ItemRecord | undefined;
  /** In insertion order. */
  listItems(jobId: string): ItemRecord[];
  listChildren(parentItemId: string): ItemRecord[];
  updateItem(id: string, patch: ItemPatch): void;
  totals(jobId: string): TransferTotals;
  /** Top-level items of a job: how many sources are in the trash, and how many were purged. */
  trashCounts(jobId: string): { trashed: number; purged: number };
  /** Top-level items of a job (the selected sources). */
  listTopLevel(jobId: string): ItemRecord[];
  /** Items of a job whose source id is `sourceId`. */
  findBySourceId(jobId: string, sourceId: string): ItemRecord[];
  /** Number of items of a job. */
  countItems(jobId: string): number;
  /**
   * At most `limit` items for display, chosen in SQL (a job can hold tens of thousands): the
   * selected sources and every item that failed, runs, was canceled or carries a warning first,
   * then the rest in insertion order.
   */
  listItemsForView(jobId: string, limit: number): ItemRecord[];
  /** Pending, non-folder items with metadata, oldest first, at most `limit`; shortcuts excluded or only. */
  listPendingFiles(jobId: string, limit: number, shortcuts: 'exclude' | 'only', shortcutMime: string): ItemRecord[];
  /** Non-folder, non-shortcut items still pending or running. */
  countUnfinishedFiles(jobId: string, shortcutMime: string): number;
  /** Pending/running items with neither a destination id nor a reserved one. */
  countNeedingPresetId(jobId: string): number;
  /** Every recorded destination id of a job. */
  listDestIds(jobId: string): string[];
  /** Full records of the items matching a named selection, in insertion order (filtered in SQL). */
  listSelection(jobId: string, selection: ItemSelection): ItemRecord[];
  /** A few columns of EVERY item of a job: about a tenth of the memory of full records. */
  listItemsLite(jobId: string): ItemLite[];
  /**
   * Items that still hold a temporary reader permission, or whose share create may have landed
   * unrecorded (`sharePending`), with the accounts of their job.
   */
  listPendingPermissions(): Array<{ item: ItemRecord; sourceAccountId: string; destAccountId: string }>;
  /** Marks every job left queued/running/verifying (and its unfinished items) as failed 'interrupted'. */
  recoverInterrupted(finishedAt: string): number;
  /**
   * Puts every job left queued/running/verifying back to 'queued' with its running items pending,
   * so it can be resumed. Returns the job ids, oldest first.
   */
  requeueUnfinished(): string[];
}

/** Creates the engine's tables when absent and returns typed accessors. Never changes pragmas. */
export function createTransferStore(db: SqlDb): TransferStore {
  db.exec(SCHEMA);
  migrate(db);

  const insertJobStmt =
    `INSERT INTO transfer_jobs
       (id, mode, source_account_id, dest_account_id, dest_folder_id, source_file_ids, confirm_move,
        status, error, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const getJobStmt =
    'SELECT * FROM transfer_jobs WHERE id = ?';
  const listJobsStmt =
    'SELECT * FROM transfer_jobs ORDER BY created_at DESC, seq DESC';
  const insertItemStmt =
    `INSERT INTO transfer_items
       (id, job_id, parent_item_id, depth, source_id, name, mime_type, is_folder, is_google_native,
        size_bytes, md5, can_copy, can_download, meta_loaded, expanded, status, strategy_used, error,
        warning, dest_id, verified, bytes_done, permission_id, source_trashed, dest_preset_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const getItemStmt =
    'SELECT * FROM transfer_items WHERE id = ?';
  const listItemsStmt =
    'SELECT * FROM transfer_items WHERE job_id = ? ORDER BY seq ASC';
  const listChildrenStmt =
    'SELECT * FROM transfer_items WHERE parent_item_id = ? ORDER BY seq ASC';
  const trashCountsStmt =
    `SELECT SUM(CASE WHEN source_trashed = 1 AND source_purged = 0 THEN 1 ELSE 0 END) AS trashed,
            SUM(CASE WHEN source_purged = 1 THEN 1 ELSE 0 END) AS purged
       FROM transfer_items WHERE job_id = ? AND parent_item_id IS NULL`;
  const listTopLevelStmt =
    'SELECT * FROM transfer_items WHERE job_id = ? AND parent_item_id IS NULL ORDER BY seq ASC';
  const findBySourceStmt =
    'SELECT * FROM transfer_items WHERE job_id = ? AND source_id = ? ORDER BY seq ASC';
  const countItemsStmt = 'SELECT COUNT(*) AS n FROM transfer_items WHERE job_id = ?';
  const listForViewStmt =
    `SELECT * FROM transfer_items WHERE job_id = ?
      ORDER BY CASE WHEN parent_item_id IS NULL OR status IN ('failed', 'running', 'canceled')
                      OR warning IS NOT NULL THEN 0 ELSE 1 END, seq ASC
      LIMIT ?`;
  const listPendingFilesStmt =
    `SELECT * FROM transfer_items
      WHERE job_id = ? AND status = 'pending' AND is_folder = 0 AND meta_loaded = 1 AND mime_type <> ?
      ORDER BY seq ASC LIMIT ?`;
  const listPendingShortcutsStmt =
    `SELECT * FROM transfer_items
      WHERE job_id = ? AND status = 'pending' AND is_folder = 0 AND meta_loaded = 1 AND mime_type = ?
      ORDER BY seq ASC LIMIT ?`;
  const countUnfinishedFilesStmt =
    `SELECT COUNT(*) AS n FROM transfer_items
      WHERE job_id = ? AND status IN ('pending', 'running') AND is_folder = 0 AND mime_type <> ?`;
  const countNeedingPresetStmt =
    `SELECT COUNT(*) AS n FROM transfer_items
      WHERE job_id = ? AND status IN ('pending', 'running') AND dest_id IS NULL AND dest_preset_id IS NULL`;
  const listDestIdsStmt = 'SELECT dest_id FROM transfer_items WHERE job_id = ? AND dest_id IS NOT NULL';
  const selectionStmts: Record<ItemSelection, string> = {
    needsMeta: `SELECT * FROM transfer_items WHERE job_id = ? AND status = 'pending' AND meta_loaded = 0 ORDER BY seq ASC`,
    foldersToExpand: `SELECT * FROM transfer_items WHERE job_id = ? AND is_folder = 1 AND meta_loaded = 1
                        AND expanded = 0 AND status = 'pending' ORDER BY seq ASC`,
    foldersToCreate: `SELECT * FROM transfer_items WHERE job_id = ? AND is_folder = 1 AND expanded = 1
                        AND status = 'pending' ORDER BY seq ASC`,
    foldersToVerify: `SELECT * FROM transfer_items WHERE job_id = ? AND is_folder = 1 AND status = 'done'
                        AND (verified IS NULL OR verified <> 1) ORDER BY seq ASC`,
    running: `SELECT * FROM transfer_items WHERE job_id = ? AND status = 'running' ORDER BY seq ASC`,
    unfinished: `SELECT * FROM transfer_items WHERE job_id = ? AND status IN ('pending', 'running') ORDER BY seq ASC`,
    pendingUnderUnfinishedParent: `SELECT i.* FROM transfer_items i JOIN transfer_items p ON p.id = i.parent_item_id
                        WHERE i.job_id = ? AND i.status = 'pending'
                          AND NOT (p.status = 'done' AND p.dest_id IS NOT NULL) ORDER BY i.seq ASC`,
    firstError: `SELECT * FROM transfer_items WHERE job_id = ? AND error IS NOT NULL ORDER BY seq ASC LIMIT 1`,
  };
  const listLiteStmt =
    `SELECT id, parent_item_id, is_folder, status, verified, source_trashed,
            CASE WHEN error IS NULL THEN 0 ELSE 1 END AS has_error
       FROM transfer_items WHERE job_id = ? ORDER BY seq ASC`;
  const totalsStmt =
    `SELECT COUNT(*) AS items,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(COALESCE(size_bytes, 0)) AS bytes_total,
            SUM(bytes_done) AS bytes_done
       FROM transfer_items WHERE job_id = ?`;
  const pendingPermissionsStmt =
    `SELECT i.*, j.source_account_id AS job_source_account_id, j.dest_account_id AS job_dest_account_id
       FROM transfer_items i JOIN transfer_jobs j ON j.id = i.job_id
      WHERE i.permission_id IS NOT NULL OR i.share_pending = 1
      ORDER BY i.seq ASC`;
  const interruptedJobsStmt =
    `SELECT id FROM transfer_jobs WHERE status IN ('queued', 'running', 'verifying')`;
  const interruptItemsStmt =
    `UPDATE transfer_items SET status = 'failed', error = 'interrupted', bytes_done = 0
      WHERE job_id = ? AND status IN ('pending', 'running')`;
  const interruptJobStmt =
    `UPDATE transfer_jobs SET status = 'failed', error = 'interrupted', finished_at = ? WHERE id = ?`;

  const store: TransferStore = {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },

    insertJob(job) {
      db.run(insertJobStmt, 
        job.id,
        job.mode,
        job.sourceAccountId,
        job.destAccountId,
        job.destFolderId,
        JSON.stringify(job.sourceFileIds),
        job.confirmMove ? 1 : 0,
        job.status,
        job.error,
        job.createdAt,
        job.finishedAt,
      );
    },

    getJob(id) {
      const row = db.get<JobRow>(getJobStmt, id);
      return row ? jobFromRow(row) : undefined;
    },

    listJobs() {
      return db.all<JobRow>(listJobsStmt).map(jobFromRow);
    },

    updateJob(id, patch) {
      const sets: string[] = [];
      const values: SqlValue[] = [];
      for (const key of Object.keys(patch) as Array<keyof JobPatch>) {
        if (patch[key] === undefined) continue;
        sets.push(`${JOB_COLUMNS[key]} = ?`);
        values.push(toSql(patch[key]));
      }
      if (sets.length === 0) return;
      values.push(id);
      db.run(`UPDATE transfer_jobs SET ${sets.join(', ')} WHERE id = ?`, ...values);
    },

    insertItem(item) {
      db.run(insertItemStmt, 
        item.id,
        item.jobId,
        item.parentItemId,
        item.depth,
        item.sourceId,
        item.name,
        item.mimeType ?? '',
        toSql(item.isFolder ?? false),
        toSql(item.isGoogleNative ?? false),
        toSql(item.sizeBytes),
        toSql(item.md5),
        toSql(item.canCopy ?? false),
        toSql(item.canDownload ?? false),
        toSql(item.metaLoaded ?? false),
        toSql(item.expanded ?? false),
        item.status ?? 'pending',
        toSql(item.strategyUsed),
        toSql(item.error),
        toSql(item.warning),
        toSql(item.destId),
        toSql(item.verified),
        item.bytesDone ?? 0,
        toSql(item.permissionId),
        toSql(item.sourceTrashed ?? false),
        toSql(item.destPresetId),
      );
    },

    getItem(id) {
      const row = db.get<ItemRow>(getItemStmt, id);
      return row ? itemFromRow(row) : undefined;
    },

    listItems(jobId) {
      return db.all<ItemRow>(listItemsStmt, jobId).map(itemFromRow);
    },

    listChildren(parentItemId) {
      return db.all<ItemRow>(listChildrenStmt, parentItemId).map(itemFromRow);
    },

    updateItem(id, patch) {
      const sets: string[] = [];
      const values: SqlValue[] = [];
      for (const key of Object.keys(patch) as Array<keyof ItemPatch>) {
        if (patch[key] === undefined) continue;
        sets.push(`${ITEM_COLUMNS[key]} = ?`);
        values.push(toSql(patch[key]));
      }
      if (sets.length === 0) return;
      values.push(id);
      db.run(`UPDATE transfer_items SET ${sets.join(', ')} WHERE id = ?`, ...values);
    },

    trashCounts(jobId) {
      const row = db.get<{ trashed: number | null; purged: number | null }>(trashCountsStmt, jobId);
      return { trashed: row?.trashed ?? 0, purged: row?.purged ?? 0 };
    },

    listTopLevel(jobId) {
      return db.all<ItemRow>(listTopLevelStmt, jobId).map(itemFromRow);
    },

    findBySourceId(jobId, sourceId) {
      return db.all<ItemRow>(findBySourceStmt, jobId, sourceId).map(itemFromRow);
    },

    countItems(jobId) {
      return db.get<{ n: number }>(countItemsStmt, jobId)?.n ?? 0;
    },

    listItemsForView(jobId, limit) {
      return db.all<ItemRow>(listForViewStmt, jobId, limit).map(itemFromRow);
    },

    listPendingFiles(jobId, limit, shortcuts, shortcutMime) {
      const stmt = shortcuts === 'only' ? listPendingShortcutsStmt : listPendingFilesStmt;
      return db.all<ItemRow>(stmt, jobId, shortcutMime, limit).map(itemFromRow);
    },

    countUnfinishedFiles(jobId, shortcutMime) {
      return db.get<{ n: number }>(countUnfinishedFilesStmt, jobId, shortcutMime)?.n ?? 0;
    },

    countNeedingPresetId(jobId) {
      return db.get<{ n: number }>(countNeedingPresetStmt, jobId)?.n ?? 0;
    },

    listSelection(jobId, selection) {
      return db.all<ItemRow>(selectionStmts[selection], jobId).map(itemFromRow);
    },

    listItemsLite(jobId) {
      return db
        .all<{
          id: string;
          parent_item_id: string | null;
          is_folder: number;
          status: string;
          verified: number | null;
          source_trashed: number;
          has_error: number;
        }>(listLiteStmt, jobId)
        .map((row) => ({
          id: row.id,
          parentItemId: row.parent_item_id,
          isFolder: row.is_folder === 1,
          status: row.status as TransferItemStatus,
          verified: row.verified === null ? null : row.verified === 1,
          sourceTrashed: row.source_trashed === 1,
          hasError: row.has_error === 1,
        }));
    },

    listDestIds(jobId) {
      return db.all<{ dest_id: string }>(listDestIdsStmt, jobId).map((row) => row.dest_id);
    },

    totals(jobId) {
      const row = db.get<TotalsRow>(totalsStmt, jobId);
      return {
        items: row?.items ?? 0,
        done: row?.done ?? 0,
        failed: row?.failed ?? 0,
        bytesTotal: row?.bytes_total ?? 0,
        bytesDone: row?.bytes_done ?? 0,
      };
    },

    listPendingPermissions() {
      return db.all<ItemRow & { job_source_account_id: string; job_dest_account_id: string }>(pendingPermissionsStmt)
        .map((row) => ({
          item: itemFromRow(row),
          sourceAccountId: row.job_source_account_id,
          destAccountId: row.job_dest_account_id,
        }));
    },

    recoverInterrupted(finishedAt) {
      return db.transaction(() => {
        const jobs = db.all<{ id: string }>(interruptedJobsStmt);
        for (const { id } of jobs) {
          db.run(interruptItemsStmt, id);
          db.run(interruptJobStmt, finishedAt, id);
        }
        return jobs.length;
      });
    },

    requeueUnfinished() {
      return db.transaction(() => {
        const jobs = db.all<{ id: string }>(
          `SELECT id FROM transfer_jobs WHERE status IN ('queued', 'running', 'verifying') ORDER BY seq ASC`,
        );
        for (const { id } of jobs) {
          db.run(
            `UPDATE transfer_items SET status = 'pending', bytes_done = 0 WHERE job_id = ? AND status = 'running'`,
            id,
          );
          db.run(`UPDATE transfer_jobs SET status = 'queued' WHERE id = ?`, id);
        }
        return jobs.map((job) => job.id);
      });
    },
  };
  return store;
}
