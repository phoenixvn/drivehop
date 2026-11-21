// Dev-only in-memory implementation of ApiClient, used with `?mock=1`.
// Loaded through a dynamic import guarded by `import.meta.env.DEV`, so it never reaches a
// production bundle. Marker for build verification: MULTICLOUD_MOCK_MARKER
import { AUTH_RESULT_PARAMS, ROOT_FOLDER_ID, isTerminalJobStatus } from '@multicloud/shared';
import type {
  CreateTransferRequest,
  FileEntry,
  SseEvent,
  TransferItem,
  TransferJob,
} from '@multicloud/shared';
import { ApiRequestError, CLIENT_ERROR_CODES } from '../api/client.ts';
import type { ApiClient, EventHandlers } from '../api/client.ts';
import { FOLDER_MIME, createMockAccounts, createMockFiles, nextMockId } from './data.ts';

const PAGE_SIZE = 25;
const LATENCY_MS = 180;
const TICK_MS = 600;
const MIB = 1024 ** 2;

type MockState = 'ok' | 'unconfigured' | 'offline';

interface MockJob extends TransferJob {
  items: TransferItem[];
  /** Bytes copied so far for the item currently running. */
  itemProgress: number;
  /** Bytes moved per tick; small for the seeded job so it stays "running" for a while. */
  bytesPerTick: number;
  /** Item ids that fail on their first attempt only. */
  failOnce: Map<string, string>;
}

function delay<T>(value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      try {
        resolve(value());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, LATENCY_MS);
  });
}

function notFound(what: string): ApiRequestError {
  return new ApiRequestError('not_found', `${what} not found (mock)`, 404);
}

export function createMockApi(search: string): ApiClient {
  const params = new URLSearchParams(search);
  const stateParam = params.get('mockState');
  let state: MockState =
    stateParam === 'unconfigured' || stateParam === 'offline' ? stateParam : 'ok';

  const accounts = createMockAccounts();
  const files = createMockFiles(accounts);
  const jobs: MockJob[] = [];
  const listeners = new Set<EventHandlers>();

  // Simulates the OAuth round trip: "reconnecting" comes back with ?connected=acc-5.
  const reconnected = params.get(AUTH_RESULT_PARAMS.connected);
  for (const entry of accounts) {
    if (entry.account.id === reconnected) entry.account.status = 'connected';
  }

  const guard = (): void => {
    if (state === 'offline') {
      throw new ApiRequestError(CLIENT_ERROR_CODES.network, 'Mock server is offline', 0);
    }
  };

  const emit = (event: SseEvent): void => {
    for (const listener of listeners) listener.onEvent(event);
  };

  const publicJob = (job: MockJob, withItems: boolean): TransferJob => {
    const { itemProgress: _p, bytesPerTick: _b, failOnce: _f, items, ...rest } = job;
    const copy: TransferJob = { ...rest, totals: { ...rest.totals } };
    if (withItems) copy.items = items.map((item) => ({ ...item }));
    return copy;
  };

  const findJob = (id: string): MockJob => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) throw notFound('Transfer');
    return job;
  };

  const childrenOf = (accountId: string, folderId: string): FileEntry[] =>
    files.filter((file) => file.accountId === accountId && file.parents.includes(folderId));

  const cloneInto = (source: FileEntry, accountId: string, parentId: string): FileEntry => {
    const clone: FileEntry = {
      ...source,
      id: nextMockId('file'),
      accountId,
      parents: [parentId],
      modifiedTime: new Date().toISOString(),
      capabilities: { ...source.capabilities },
    };
    files.push(clone);
    if (source.isFolder) {
      for (const child of childrenOf(source.accountId, source.id)) {
        cloneInto(child, accountId, clone.id);
      }
    }
    return clone;
  };

  const removeFile = (fileId: string): void => {
    const index = files.findIndex((file) => file.id === fileId);
    if (index >= 0) files.splice(index, 1);
  };

  const recount = (job: MockJob): void => {
    job.totals.done = job.items.filter((item) => item.status === 'done').length;
    job.totals.failed = job.items.filter((item) => item.status === 'failed').length;
    const doneBytes = job.items
      .filter((item) => item.status === 'done')
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    job.totals.bytesDone = Math.min(job.totals.bytesTotal, doneBytes + job.itemProgress);
  };

  const finishJob = (job: MockJob): void => {
    const anyFailed = job.items.some((item) => item.status === 'failed');
    const allFailed = job.items.every((item) => item.status === 'failed');
    job.status = allFailed ? 'failed' : anyFailed ? 'completed_with_errors' : 'completed';
    job.finishedAt = new Date().toISOString();
    // Like the real engine: originals go to the trash only when every item was copied.
    if (job.mode === 'move' && !anyFailed) {
      for (const item of job.items) removeFile(item.sourceId);
    }
    recount(job);
    emit({ type: 'job.finished', payload: { job: publicJob(job, false) } });
  };

  const tick = (): void => {
    for (const job of jobs) {
      if (job.status === 'queued') {
        job.status = 'running';
        emit({ type: 'job.updated', payload: { job: publicJob(job, false) } });
        continue;
      }
      if (job.status !== 'running') continue;

      const item =
        job.items.find((candidate) => candidate.status === 'running') ??
        job.items.find((candidate) => candidate.status === 'pending');
      if (!item) {
        finishJob(job);
        continue;
      }
      if (item.status === 'pending') {
        item.status = 'running';
        job.itemProgress = 0;
        emit({ type: 'item.updated', payload: { jobId: job.id, item: { ...item } } });
      }

      job.itemProgress += job.bytesPerTick;
      if (job.itemProgress >= item.sizeBytes) {
        job.itemProgress = 0;
        const failure = job.failOnce.get(item.id);
        if (failure) {
          job.failOnce.delete(item.id);
          item.status = 'failed';
          item.error = failure;
        } else {
          const source = files.find((file) => file.id === item.sourceId);
          if (source) {
            const clone = cloneInto(source, job.destAccountId, job.destFolderId);
            item.destId = clone.id;
            item.status = 'done';
            item.verified = true;
            item.strategyUsed = source.isGoogleNative ? 'permission-copy' : 'stream';
            delete item.error;
          } else {
            item.status = 'failed';
            item.error = 'not_found: source file no longer exists';
          }
        }
        emit({ type: 'item.updated', payload: { jobId: job.id, item: { ...item } } });
      }
      recount(job);
      emit({ type: 'job.updated', payload: { job: publicJob(job, false) } });
    }
  };

  const addJob = (
    req: CreateTransferRequest,
    options: { bytesPerTick?: number; createdAt?: string } = {},
  ): MockJob => {
    const jobId = nextMockId('job');
    const failOnce = new Map<string, string>();
    const items: TransferItem[] = req.sourceFileIds.map((sourceId) => {
      const source = files.find((file) => file.id === sourceId);
      const item: TransferItem = {
        id: nextMockId('item'),
        jobId,
        sourceId,
        name: source?.name ?? sourceId,
        isFolder: source?.isFolder ?? false,
        sizeBytes: source?.sizeBytes ?? 0,
        status: 'pending',
      };
      // Google-native files cannot be streamed; across accounts the mock fails them once so the
      // error text and "Thử lại mục lỗi" can be exercised.
      if (source?.isGoogleNative && req.sourceAccountId !== req.destAccountId) {
        failOnce.set(
          item.id,
          'google_native_not_streamable: Google Docs/Sheets/Slides have no binary content',
        );
      }
      return item;
    });
    const job: MockJob = {
      id: jobId,
      mode: req.mode,
      sourceAccountId: req.sourceAccountId,
      destAccountId: req.destAccountId,
      destFolderId: req.destFolderId,
      status: 'queued',
      createdAt: options.createdAt ?? new Date().toISOString(),
      totals: {
        items: items.length,
        done: 0,
        failed: 0,
        bytesTotal: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        bytesDone: 0,
      },
      items,
      itemProgress: 0,
      bytesPerTick: options.bytesPerTick ?? 256 * MIB,
      failOnce,
    };
    jobs.unshift(job);
    return job;
  };

  // --- Seed: one finished job with errors, one job that is still running -------------------
  const rootOf = (accountId: string): FileEntry[] => childrenOf(accountId, ROOT_FOLDER_ID);
  const pick = (accountId: string, predicate: (file: FileEntry) => boolean): string[] =>
    rootOf(accountId)
      .filter(predicate)
      .map((file) => file.id);

  const finished = addJob(
    {
      mode: 'copy',
      sourceAccountId: 'acc-1',
      destAccountId: 'acc-3',
      destFolderId: ROOT_FOLDER_ID,
      sourceFileIds: pick('acc-1', (file) => !file.isFolder).slice(0, 4),
    },
    { createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
  );
  finished.failOnce.clear();
  finished.items.forEach((item, index) => {
    const source = files.find((file) => file.id === item.sourceId);
    if (source?.isGoogleNative) {
      item.status = 'failed';
      item.error = 'google_native_not_streamable';
    } else if (index === 3) {
      item.status = 'failed';
      item.error = 'rate_limit: User rate limit exceeded (403 userRateLimitExceeded)';
    } else {
      item.status = 'done';
      item.verified = true;
      item.strategyUsed = 'stream';
    }
  });
  finished.status = 'completed_with_errors';
  finished.finishedAt = new Date(Date.now() - 3 * 3_600_000 + 95_000).toISOString();
  recount(finished);

  const running = addJob(
    {
      mode: 'move',
      sourceAccountId: 'acc-2',
      destAccountId: 'acc-1',
      destFolderId: ROOT_FOLDER_ID,
      sourceFileIds: pick('acc-2', (file) => (file.sizeBytes ?? 0) > 100 * MIB),
    },
    { bytesPerTick: 24 * MIB },
  );
  running.status = 'running';

  if (state !== 'offline') window.setInterval(tick, TICK_MS);

  return {
    getStatus: () =>
      delay(() => {
        guard();
        const setup = {
          allowed: state === 'unconfigured',
          redirectUri: 'http://localhost:8787/api/auth/google/callback',
          webOrigin: 'http://localhost:8787',
        };
        return state === 'unconfigured'
          ? {
              configured: false,
              missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
              keyringAvailable: true,
              setup,
            }
          : { configured: true, missing: [], keyringAvailable: true, setup };
      }),
    saveSetup: (req) =>
      delay(() => {
        guard();
        if (!/\.apps\.googleusercontent\.com$/.test(req.clientId.trim()) || req.clientSecret.trim().length < 8) {
          throw new ApiRequestError('bad_request', 'Client ID hoặc client secret không hợp lệ (mock).', 400);
        }
        state = 'ok';
      }),

    listAccounts: () =>
      delay(() => {
        guard();
        return accounts.map((entry) => ({ ...entry.account }));
      }),

    deleteAccount: (id) =>
      delay(() => {
        guard();
        const index = accounts.findIndex((entry) => entry.account.id === id);
        if (index < 0) throw notFound('Account');
        accounts.splice(index, 1);
      }),

    getQuota: (id) =>
      delay(() => {
        guard();
        const entry = accounts.find((candidate) => candidate.account.id === id);
        if (!entry) throw notFound('Account');
        if (entry.account.status === 'needs_reconnect') {
          throw new ApiRequestError('needs_reconnect', 'Account must be reconnected (mock)', 401);
        }
        return { ...entry.quota };
      }),

    listFiles: (accountId, query = {}) =>
      delay(() => {
        guard();
        const entry = accounts.find((candidate) => candidate.account.id === accountId);
        if (!entry) throw notFound('Account');
        if (entry.account.status === 'needs_reconnect') {
          throw new ApiRequestError('needs_reconnect', 'Account must be reconnected (mock)', 401);
        }
        const all = childrenOf(accountId, query.folderId ?? ROOT_FOLDER_ID);
        const start = query.pageToken ? Number(query.pageToken) : 0;
        const page = all.slice(start, start + PAGE_SIZE).map((file) => ({ ...file }));
        const next = start + PAGE_SIZE;
        return next < all.length
          ? { entries: page, nextPageToken: String(next) }
          : { entries: page };
      }),

    getFolderPath: (accountId, folderId) =>
      delay(() => {
        guard();
        const crumbs = [];
        let currentId = folderId;
        while (currentId !== ROOT_FOLDER_ID) {
          const folder = files.find(
            (file) =>
              file.id === currentId && file.accountId === accountId && file.mimeType === FOLDER_MIME,
          );
          if (!folder) throw notFound('Folder');
          crumbs.unshift({ id: folder.id, name: folder.name });
          currentId = folder.parents[0] ?? ROOT_FOLDER_ID;
        }
        crumbs.unshift({ id: ROOT_FOLDER_ID, name: 'My Drive' });
        return crumbs;
      }),

    listTransfers: () =>
      delay(() => {
        guard();
        return jobs.map((job) => publicJob(job, false));
      }),

    getTransfer: (id) =>
      delay(() => {
        guard();
        return publicJob(findJob(id), true);
      }),

    createTransfer: (req) =>
      delay(() => {
        guard();
        if (req.mode === 'move' && req.confirmMove !== true) {
          throw new ApiRequestError('move_not_confirmed', 'move requires confirmMove', 400);
        }
        const job = addJob(req);
        const created = publicJob(job, false);
        emit({ type: 'job.created', payload: { job: created } });
        return created;
      }),

    cancelTransfer: (id) =>
      delay(() => {
        guard();
        const job = findJob(id);
        if (!isTerminalJobStatus(job.status)) {
          for (const item of job.items) {
            if (item.status === 'pending' || item.status === 'running') item.status = 'canceled';
          }
          job.itemProgress = 0;
          job.status = 'canceled';
          job.finishedAt = new Date().toISOString();
          recount(job);
          emit({ type: 'job.finished', payload: { job: publicJob(job, false) } });
        }
        return publicJob(job, false);
      }),

    retryFailedTransfer: (id) =>
      delay(() => {
        guard();
        const job = findJob(id);
        for (const item of job.items) {
          // Like the server: failed AND canceled items run again, the job goes back to the queue.
          if (item.status === 'failed' || item.status === 'canceled') {
            item.status = 'pending';
            delete item.error;
            emit({ type: 'item.updated', payload: { jobId: job.id, item: { ...item } } });
          }
        }
        job.status = 'queued';
        delete job.finishedAt;
        delete job.error;
        recount(job);
        const updated = publicJob(job, false);
        emit({ type: 'job.updated', payload: { job: updated } });
        return updated;
      }),

    purgeTrashedSources: (id) =>
      delay(() => {
        guard();
        const job = findJob(id);
        let purged = 0;
        for (const item of job.items) {
          if (item.sourceTrashed && !item.sourcePurged) {
            item.sourcePurged = true;
            purged++;
            emit({ type: 'item.updated', payload: { jobId: job.id, item: { ...item } } });
          }
        }
        if (job.trash) job.trash = { trashed: 0, purged: job.trash.purged + purged };
        const updated = publicJob(job, false);
        emit({ type: 'job.updated', payload: { job: updated } });
        return { job: updated, purged, skipped: 0, failed: 0, remaining: 0 };
      }),

    // The real URL would leave the page for Google; the mock comes straight back with a result.
    authStartUrl: () =>
      `${window.location.pathname}?mock=1&${AUTH_RESULT_PARAMS.connected}=acc-5${window.location.hash}`,

    openEvents: (handlers) => {
      if (state === 'offline') {
        const failTimer = window.setTimeout(() => handlers.onClose(), LATENCY_MS);
        return () => window.clearTimeout(failTimer);
      }
      listeners.add(handlers);
      const timer = window.setTimeout(() => handlers.onOpen(), 0);
      return () => {
        window.clearTimeout(timer);
        listeners.delete(handlers);
      };
    },
  };
}
