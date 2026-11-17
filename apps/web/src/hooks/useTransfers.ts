import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminalJobStatus } from '@multicloud/shared';
import type {
  SseEvent,
  TransferItem,
  TransferJob,
  TransferJobStatus,
} from '@multicloud/shared';
import type { ApiClient } from '../api/client.ts';
import { apiErrorText } from '../lib/format.ts';
import { createLiveConnection } from '../lib/liveEvents.ts';
import type { LiveConnection, LiveState } from '../lib/liveEvents.ts';

export type ItemsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: TransferItem[]; omitted?: number };

export interface TransfersState {
  /** Newest first, never carrying `items` (those live in `itemsByJob`). */
  jobs: TransferJob[];
  loadState: 'loading' | 'ready' | 'error';
  error: string | null;
  /**
   * False only while a job is active and the live stream is down (the list may be stale). With no
   * active job no stream is open on purpose, and that is not reported as a problem.
   */
  live: boolean;
  liveState: LiveState;
  itemsByJob: Record<string, ItemsState>;
  activeCount: number;
  reload: () => void;
  loadItems: (jobId: string) => void;
  /** Merges a job returned by a request (create / cancel / retry) into the list. */
  applyJob: (job: TransferJob) => void;
}

function withoutItems(job: TransferJob): TransferJob {
  const { items: _items, ...rest } = job;
  return rest;
}

function sortJobs(jobs: Iterable<TransferJob>): TransferJob[] {
  return [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function mergeItem(items: TransferItem[], item: TransferItem): TransferItem[] {
  return items.some((existing) => existing.id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];
}

/**
 * Keeps the transfer list in sync: GET /api/transfers on mount, on every (re)connection of the
 * event stream, after the server's idle close, on demand (`reload`), and every 15 s only while a
 * job is active and the stream is down; live events in between. The stream itself is open only
 * while a job is queued or running (see lib/liveEvents.ts). `onJobFinished` fires once each time a job reaches a terminal
 * status, including when that happened while the stream was disconnected.
 */
export function useTransfers(
  api: ApiClient,
  enabled: boolean,
  onJobFinished: (job: TransferJob) => void,
): TransfersState {
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [loadState, setLoadState] = useState<TransfersState['loadState']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<LiveState>('off');
  const [itemsByJob, setItemsByJob] = useState<Record<string, ItemsState>>({});

  const onFinishedRef = useRef(onJobFinished);
  useEffect(() => {
    onFinishedRef.current = onJobFinished;
  }, [onJobFinished]);

  // Mutable mirror of the list so event handlers never work from a stale render.
  const jobsRef = useRef(new Map<string, TransferJob>());
  const statusRef = useRef(new Map<string, TransferJobStatus>());
  const loadedOnceRef = useRef(false);
  // While a list request is in flight, events are held back and replayed on top of its result,
  // so an older list snapshot can never overwrite a newer event.
  const fetchingRef = useRef(false);
  const heldEventsRef = useRef<SseEvent[]>([]);
  const fetchSeqRef = useRef(0);
  // Same idea per job for GET /api/transfers/:id versus `item.updated` events.
  const itemFetchRef = useRef(new Map<string, { seq: number; held: TransferItem[] }>());
  const loadedItemsRef = useRef(new Set<string>());
  const aliveRef = useRef(false);
  const refetchRef = useRef<() => void>(() => {});
  const connectionRef = useRef<LiveConnection | null>(null);

  const publish = useCallback(() => {
    setJobs(sortJobs(jobsRef.current.values()));
  }, []);

  const loadItems = useCallback(
    (jobId: string) => {
      const seq = (itemFetchRef.current.get(jobId)?.seq ?? 0) + 1;
      itemFetchRef.current.set(jobId, { seq, held: [] });
      setItemsByJob((prev) => (prev[jobId]?.kind === 'ready' ? prev : { ...prev, [jobId]: { kind: 'loading' } }));
      api.getTransfer(jobId).then(
        (job) => {
          const pending = itemFetchRef.current.get(jobId);
          if (!aliveRef.current || !pending || pending.seq !== seq) return;
          itemFetchRef.current.delete(jobId);
          let items = job.items ?? [];
          for (const item of pending.held) items = mergeItem(items, item);
          loadedItemsRef.current.add(jobId);
          const omitted = job.itemsOmitted;
          setItemsByJob((prev) => ({
            ...prev,
            [jobId]: omitted === undefined ? { kind: 'ready', items } : { kind: 'ready', items, omitted },
          }));
        },
        (cause: unknown) => {
          const pending = itemFetchRef.current.get(jobId);
          if (!aliveRef.current || !pending || pending.seq !== seq) return;
          itemFetchRef.current.delete(jobId);
          setItemsByJob((prev) =>
            prev[jobId]?.kind === 'ready'
              ? prev
              : { ...prev, [jobId]: { kind: 'error', message: apiErrorText(cause) } },
          );
        },
      );
    },
    [api],
  );

  /** Upserts one job into the mirror. Returns true when this update made it terminal. */
  const upsert = useCallback((incoming: TransferJob): boolean => {
    const job = withoutItems(incoming);
    const previous = statusRef.current.get(job.id);
    jobsRef.current.set(job.id, job);
    statusRef.current.set(job.id, job.status);
    if (!isTerminalJobStatus(job.status)) return false;
    // Unknown job that is already terminal: on the very first load that is just history; later
    // on it means the job started and finished while we were not listening.
    return previous === undefined ? loadedOnceRef.current : !isTerminalJobStatus(previous);
  }, []);

  const notifyFinished = useCallback(
    (job: TransferJob) => {
      if (loadedItemsRef.current.has(job.id)) loadItems(job.id);
      onFinishedRef.current(job);
    },
    [loadItems],
  );

  const applyJob = useCallback(
    (job: TransferJob) => {
      const finished = upsert(job);
      publish();
      if (finished) notifyFinished(job);
    },
    [upsert, publish, notifyFinished],
  );

  /**
   * A job returned by create / retry / cancel. With no stream open while idle, this response may be
   * the only news of a new active job, so a list request already in flight (started before the
   * change) must not overwrite it: that request is dropped and a fresh one is started.
   */
  const applyMutation = useCallback(
    (job: TransferJob) => {
      applyJob(job);
      if (fetchingRef.current) refetchRef.current();
    },
    [applyJob],
  );

  const applyEvent = useCallback(
    (event: SseEvent) => {
      if (event.type === 'item.updated') {
        const { jobId, item } = event.payload;
        const pending = itemFetchRef.current.get(jobId);
        if (pending) pending.held.push(item);
        setItemsByJob((prev) => {
          const current = prev[jobId];
          if (current?.kind !== 'ready') return prev;
          return { ...prev, [jobId]: { ...current, items: mergeItem(current.items, item) } };
        });
        return;
      }
      applyJob(event.payload.job);
    },
    [applyJob],
  );

  const refetch = useCallback(() => {
    const seq = fetchSeqRef.current + 1;
    fetchSeqRef.current = seq;
    fetchingRef.current = true;
    heldEventsRef.current = [];
    api.listTransfers().then(
      (list) => {
        if (!aliveRef.current || fetchSeqRef.current !== seq) return;
        const finished: TransferJob[] = [];
        const next = new Map<string, TransferJob>();
        for (const job of list) {
          if (upsert(job)) finished.push(job);
          next.set(job.id, withoutItems(job));
        }
        jobsRef.current = next;
        loadedOnceRef.current = true;
        fetchingRef.current = false;
        const held = heldEventsRef.current;
        heldEventsRef.current = [];
        setError(null);
        setLoadState('ready');
        publish();
        for (const job of finished) notifyFinished(job);
        for (const event of held) applyEvent(event);
        // Item lists that are open may have missed events while disconnected.
        for (const jobId of loadedItemsRef.current) {
          if (next.has(jobId)) loadItems(jobId);
        }
      },
      (cause: unknown) => {
        if (!aliveRef.current || fetchSeqRef.current !== seq) return;
        fetchingRef.current = false;
        const held = heldEventsRef.current;
        heldEventsRef.current = [];
        setError(apiErrorText(cause));
        setLoadState((prev) => (prev === 'ready' ? 'ready' : 'error'));
        for (const event of held) applyEvent(event);
      },
    );
  }, [api, upsert, publish, notifyFinished, applyEvent, loadItems]);

  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  const activeCount = jobs.filter((job) => !isTerminalJobStatus(job.status)).length;
  const hasActive = activeCount > 0;
  const hasActiveRef = useRef(hasActive);
  hasActiveRef.current = hasActive;

  useEffect(() => {
    if (!enabled) return;
    aliveRef.current = true;
    const connection = createLiveConnection({
      open: api.openEvents,
      onConnected: () => refetchRef.current(),
      onEvent: (event) => {
        if (fetchingRef.current) heldEventsRef.current.push(event);
        else applyEvent(event);
      },
      // The server says nothing is running: confirm with the list (it decides `hasActive`).
      onEnded: (reason) => {
        if (reason === 'idle') refetchRef.current();
      },
      onPoll: () => refetchRef.current(),
      onStateChange: (state) => {
        if (aliveRef.current) setLiveState(state);
      },
    });
    connectionRef.current = connection;
    // The list must not depend on the stream (none is open while no job is active).
    refetch();
    connection.setActive(hasActiveRef.current);
    return () => {
      aliveRef.current = false;
      fetchSeqRef.current += 1;
      fetchingRef.current = false;
      connectionRef.current = null;
      connection.dispose();
    };
  }, [api, enabled, refetch, applyEvent]);

  // Connect only while at least one job is queued or running.
  useEffect(() => {
    connectionRef.current?.setActive(hasActive);
  }, [hasActive]);

  return {
    jobs,
    loadState,
    error,
    live: !(hasActive && liveState === 'waiting'),
    liveState,
    itemsByJob,
    activeCount,
    reload: refetch,
    loadItems,
    applyJob: applyMutation,
  };
}
