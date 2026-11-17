import { useCallback, useEffect, useRef, useState } from 'react';
import { ROOT_FOLDER_ID } from '@multicloud/shared';
import type { AccountWithQuota, Breadcrumb, FileEntry } from '@multicloud/shared';
import type { ApiClient } from '../api/client.ts';
import { apiErrorText, isNeedsReconnect, sortEntries } from '../lib/format.ts';

export const ROOT_LABEL = 'Drive của tôi';

export interface PaneState {
  accountId: string | null;
  folderId: string;
  entries: FileEntry[];
  breadcrumbs: Breadcrumb[];
  loadState: 'idle' | 'loading' | 'ready' | 'error';
  /** True while an already visible listing is being re-fetched in the background. */
  refreshing: boolean;
  error: string | null;
  needsReconnect: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  selectedIds: ReadonlySet<string>;
  setAccount: (accountId: string) => void;
  openFolder: (folderId: string) => void;
  refresh: () => void;
  loadMore: () => void;
  setSelectedIds: (ids: ReadonlySet<string>) => void;
}

function mergeEntries(current: readonly FileEntry[], more: readonly FileEntry[]): FileEntry[] {
  const byId = new Map<string, FileEntry>();
  for (const entry of current) byId.set(entry.id, entry);
  for (const entry of more) byId.set(entry.id, entry);
  return sortEntries([...byId.values()]);
}

/**
 * State of one browser pane. `externalVersion` changes when a finished transfer touched the
 * pane's account; the listing is then re-fetched without clearing what is on screen.
 */
export function usePane(
  api: ApiClient,
  accounts: readonly AccountWithQuota[],
  externalVersion: (accountId: string) => number,
  /** Which connected account to start on (0 = first, 1 = second, ...), so the panes differ. */
  defaultIndex = 0,
): PaneState {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string>(ROOT_FOLDER_ID);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [loadState, setLoadState] = useState<PaneState['loadState']>('idle');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [manualVersion, setManualVersion] = useState(0);

  // Identifies the listing currently on screen; any response for another one is dropped.
  const listingSeqRef = useRef(0);
  const shownKeyRef = useRef<string | null>(null);

  // Pick a default account, and recover when the selected one was removed.
  useEffect(() => {
    if (accountId !== null && accounts.some((account) => account.id === accountId)) return;
    const connected = accounts.filter((account) => account.status === 'connected');
    const fallback = connected[defaultIndex] ?? connected[0] ?? accounts[0] ?? null;
    const nextId = fallback?.id ?? null;
    if (nextId !== accountId) {
      setAccountId(nextId);
      setFolderId(ROOT_FOLDER_ID);
    }
  }, [accounts, accountId, defaultIndex]);

  const version = (accountId === null ? 0 : externalVersion(accountId)) + manualVersion;

  useEffect(() => {
    if (accountId === null) {
      shownKeyRef.current = null;
      setEntries([]);
      setBreadcrumbs([]);
      setLoadState('idle');
      return;
    }
    const seq = listingSeqRef.current + 1;
    listingSeqRef.current = seq;
    const key = `${accountId}\n${folderId}`;
    const isRefresh = shownKeyRef.current === key;
    if (isRefresh) {
      setRefreshing(true);
    } else {
      shownKeyRef.current = null;
      setEntries([]);
      setBreadcrumbs([]);
      setNextPageToken(null);
      setSelectedIds(new Set<string>());
      setLoadState('loading');
    }
    setError(null);
    setNeedsReconnect(false);
    setLoadingMore(false);
    setLoadMoreError(null);

    const isCurrent = (): boolean => listingSeqRef.current === seq;

    api.listFiles(accountId, { folderId }).then(
      (listing) => {
        if (!isCurrent()) return;
        shownKeyRef.current = key;
        const sorted = sortEntries(listing.entries);
        setEntries(sorted);
        setNextPageToken(listing.nextPageToken ?? null);
        // After a background refresh, drop selections that no longer exist.
        const ids = new Set(sorted.map((entry) => entry.id));
        setSelectedIds((prev) => {
          const kept = [...prev].filter((id) => ids.has(id));
          return kept.length === prev.size ? prev : new Set(kept);
        });
        setLoadState('ready');
        setRefreshing(false);
      },
      (cause: unknown) => {
        if (!isCurrent()) return;
        shownKeyRef.current = null;
        setEntries([]);
        setNextPageToken(null);
        setSelectedIds(new Set<string>());
        setError(apiErrorText(cause));
        setNeedsReconnect(isNeedsReconnect(cause));
        setLoadState('error');
        setRefreshing(false);
      },
    );

    api.getFolderPath(accountId, folderId).then(
      (crumbs) => {
        if (isCurrent()) setBreadcrumbs(crumbs);
      },
      () => {
        // The listing is still usable without a path; show at least a way back to the root.
        if (isCurrent()) setBreadcrumbs([{ id: ROOT_FOLDER_ID, name: ROOT_LABEL }]);
      },
    );

    return () => {
      // Invalidate in-flight responses (also covers the StrictMode double run).
      if (listingSeqRef.current === seq) listingSeqRef.current = seq + 1;
    };
  }, [api, accountId, folderId, version]);

  const setAccount = useCallback((nextAccountId: string) => {
    setAccountId(nextAccountId);
    setFolderId(ROOT_FOLDER_ID);
  }, []);

  const openFolder = useCallback((nextFolderId: string) => setFolderId(nextFolderId), []);

  const refresh = useCallback(() => setManualVersion((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (accountId === null || nextPageToken === null || loadingMore) return;
    const seq = listingSeqRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    api.listFiles(accountId, { folderId, pageToken: nextPageToken }).then(
      (listing) => {
        if (listingSeqRef.current !== seq) return;
        setEntries((prev) => mergeEntries(prev, listing.entries));
        setNextPageToken(listing.nextPageToken ?? null);
        setLoadingMore(false);
      },
      (cause: unknown) => {
        if (listingSeqRef.current !== seq) return;
        setLoadMoreError(apiErrorText(cause));
        setLoadingMore(false);
      },
    );
  }, [api, accountId, folderId, nextPageToken, loadingMore]);

  return {
    accountId,
    folderId,
    entries,
    breadcrumbs,
    loadState,
    refreshing,
    error,
    needsReconnect,
    hasMore: nextPageToken !== null,
    loadingMore,
    loadMoreError,
    selectedIds,
    setAccount,
    openFolder,
    refresh,
    loadMore,
    setSelectedIds,
  };
}
