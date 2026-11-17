import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountWithQuota, StatusResponse } from '@multicloud/shared';
import { isSessionExpiredError, isUnreachableError } from '../api/client.ts';
import type { ApiClient } from '../api/client.ts';
import { apiErrorText } from '../lib/format.ts';

export type ServerState =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  /** 401/403 from the auth layer (or its login redirect): the page has to be reloaded. */
  | { kind: 'session_expired' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: StatusResponse };

export interface ServerStatusState {
  server: ServerState;
  retry: () => void;
  /** Any API call found the session expired: show the reload banner. */
  markSessionExpired: () => void;
}

export function useServerStatus(api: ApiClient): ServerStatusState {
  const [server, setServer] = useState<ServerState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;
    api.getStatus().then(
      (status) => {
        if (!ignore) setServer({ kind: 'ready', status });
      },
      (error: unknown) => {
        if (ignore) return;
        setServer(
          isSessionExpiredError(error)
            ? { kind: 'session_expired' }
            : isUnreachableError(error)
              ? { kind: 'unreachable' }
              : { kind: 'error', message: apiErrorText(error) },
        );
      },
    );
    return () => {
      ignore = true;
    };
  }, [api, attempt]);

  const retry = useCallback(() => {
    setServer({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  const markSessionExpired = useCallback(() => setServer({ kind: 'session_expired' }), []);

  return { server, retry, markSessionExpired };
}

export type QuotaLoadState = 'loading' | 'ready' | 'error';

export interface AccountsState {
  loadState: 'loading' | 'ready' | 'error';
  error: string | null;
  accounts: AccountWithQuota[];
  quotaStates: Record<string, QuotaLoadState>;
  reload: () => void;
  /**
   * Background re-fetch of the account list (no loading state, errors ignored while a list is
   * shown). Quota is re-fetched only for accounts that are new or whose status changed.
   */
  refresh: () => void;
  /** Re-fetches quota for the given accounts (all accounts when omitted). */
  refreshQuotas: (accountIds?: readonly string[]) => void;
  /** Removes the account from the local list after a successful DELETE. */
  removeLocal: (accountId: string) => void;
}

export function useAccounts(api: ApiClient, enabled: boolean): AccountsState {
  const [loadState, setLoadState] = useState<AccountsState['loadState']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountWithQuota[]>([]);
  const [quotaStates, setQuotaStates] = useState<Record<string, QuotaLoadState>>({});
  const [attempt, setAttempt] = useState(0);
  const accountIdsRef = useRef<string[]>([]);
  // Mirror of `accounts` (with quota) so a background refresh keeps the quota already shown.
  const accountsRef = useRef<AccountWithQuota[]>([]);
  // Increases on every quota request per account so a slow, older response cannot win.
  const quotaSeqRef = useRef(new Map<string, number>());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadQuota = useCallback(
    (accountId: string) => {
      const seq = (quotaSeqRef.current.get(accountId) ?? 0) + 1;
      quotaSeqRef.current.set(accountId, seq);
      const isCurrent = (): boolean =>
        aliveRef.current && quotaSeqRef.current.get(accountId) === seq;
      setQuotaStates((prev) => ({ ...prev, [accountId]: 'loading' }));
      api.getQuota(accountId).then(
        (quota) => {
          if (!isCurrent()) return;
          const withQuota = (list: AccountWithQuota[]): AccountWithQuota[] =>
            list.map((account) => (account.id === accountId ? { ...account, quota } : account));
          accountsRef.current = withQuota(accountsRef.current);
          setAccounts(withQuota);
          setQuotaStates((prev) => ({ ...prev, [accountId]: 'ready' }));
        },
        () => {
          if (!isCurrent()) return;
          setQuotaStates((prev) => ({ ...prev, [accountId]: 'error' }));
        },
      );
    },
    [api],
  );

  const listSeqRef = useRef(0);
  const enabledRef = useRef(enabled);
  const hasListRef = useRef(false);

  const loadList = useCallback(
    (background: boolean) => {
      const seq = listSeqRef.current + 1;
      listSeqRef.current = seq;
      if (!background) setLoadState('loading');
      api.listAccounts().then(
        (list) => {
          if (!aliveRef.current || listSeqRef.current !== seq) return;
          const previous = accountsRef.current;
          const next = list.map((account) => ({
            ...account,
            quota: previous.find((old) => old.id === account.id)?.quota ?? null,
          }));
          accountsRef.current = next;
          accountIdsRef.current = list.map((account) => account.id);
          hasListRef.current = true;
          setAccounts(next);
          setError(null);
          setLoadState('ready');
          for (const account of list) {
            const old = previous.find((entry) => entry.id === account.id);
            if (!background || !old || old.status !== account.status) loadQuota(account.id);
          }
        },
        (cause: unknown) => {
          if (!aliveRef.current || listSeqRef.current !== seq) return;
          // A failed background refresh keeps the list that is on screen.
          if (background && hasListRef.current) return;
          setError(apiErrorText(cause));
          setLoadState('error');
        },
      );
    },
    [api, loadQuota],
  );

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) return;
    loadList(false);
    return () => {
      listSeqRef.current += 1;
    };
  }, [enabled, attempt, loadList]);

  const refresh = useCallback(() => {
    if (enabledRef.current) loadList(true);
  }, [loadList]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const refreshQuotas = useCallback(
    (accountIds?: readonly string[]) => {
      const known = accountIdsRef.current;
      const ids = accountIds ? accountIds.filter((id) => known.includes(id)) : known;
      for (const id of new Set(ids)) loadQuota(id);
    },
    [loadQuota],
  );

  const removeLocal = useCallback((accountId: string) => {
    accountIdsRef.current = accountIdsRef.current.filter((id) => id !== accountId);
    accountsRef.current = accountsRef.current.filter((account) => account.id !== accountId);
    setAccounts((prev) => prev.filter((account) => account.id !== accountId));
  }, []);

  return { loadState, error, accounts, quotaStates, reload, refresh, refreshQuotas, removeLocal };
}
