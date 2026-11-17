import { useCallback, useEffect, useRef, useState } from 'react';
import { API_ERROR_CODES, AUTH_RESULT_PARAMS } from '@multicloud/shared';
import type { TransferJob } from '@multicloud/shared';
import { useApi, useApiSignals, useIsMock } from './api/ApiContext.ts';
import { CLIENT_ERROR_CODES } from './api/client.ts';
import { FileBrowser } from './components/FileBrowser.tsx';
import { Overview } from './components/Overview.tsx';
import { SetupBanner } from './components/SetupBanner.tsx';
import { ToastList, useToasts } from './components/Toasts.tsx';
import { TransfersDrawer } from './components/TransfersDrawer.tsx';
import { useAccounts, useServerStatus } from './hooks/useServer.ts';
import { useTransfers } from './hooks/useTransfers.ts';
import { MODE_LABELS, authErrorText } from './lib/format.ts';

type View = 'overview' | 'files';

const VIEW_HASHES: Record<View, string> = {
  overview: '#/tong-quan',
  files: '#/tep',
};

function viewFromHash(hash: string): View {
  return hash === VIEW_HASHES.files ? 'files' : 'overview';
}

export function App() {
  const api = useApi();
  const isMock = useIsMock();
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const signals = useApiSignals();
  const { server, retry: retryServer, markSessionExpired } = useServerStatus(api);
  const serverReady = server.kind === 'ready';
  const accountsState = useAccounts(api, serverReady);
  const { refreshQuotas, refresh: refreshAccounts } = accountsState;
  // Mirror for listeners registered once.
  const accountsRef = useRef(accountsState.accounts);
  accountsRef.current = accountsState.accounts;

  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));
  const [filesVisited, setFilesVisited] = useState(view === 'files');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  // Per-account counters; a pane re-fetches its listing when its account's counter changes.
  const [listingVersions, setListingVersions] = useState<Record<string, number>>({});

  useEffect(() => {
    const onHashChange = (): void => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (view === 'files') setFilesVisited(true);
  }, [view]);

  // Result of the OAuth round trip: show it once, then remove it from the address bar so a
  // reload does not repeat it. Reading and cleaning happen in the same run (StrictMode-safe).
  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get(AUTH_RESULT_PARAMS.connected);
    const authError = url.searchParams.get(AUTH_RESULT_PARAMS.error);
    if (connected === null && authError === null) return;
    url.searchParams.delete(AUTH_RESULT_PARAMS.connected);
    url.searchParams.delete(AUTH_RESULT_PARAMS.error);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (authError !== null) pushToast('error', authErrorText(authError));
    else pushToast('success', 'Đã kết nối tài khoản Google thành công.');
  }, [pushToast]);

  const handleJobFinished = useCallback(
    (job: TransferJob) => {
      const affected = [...new Set([job.sourceAccountId, job.destAccountId])];
      refreshQuotas(affected);
      // A job may have found a revoked token: the account cards must show it.
      refreshAccounts();
      setListingVersions((prev) => {
        const next = { ...prev };
        for (const id of affected) next[id] = (next[id] ?? 0) + 1;
        return next;
      });
      const mode = MODE_LABELS[job.mode];
      const { done, items, failed } = job.totals;
      if (job.status === 'completed') {
        pushToast('success', `${mode} hoàn tất: ${done}/${items} mục.`);
      } else if (job.status === 'completed_with_errors') {
        pushToast('error', `${mode} kết thúc với ${failed} mục lỗi. Mở “Chuyển tệp” để xem và thử lại.`);
      } else if (job.status === 'failed') {
        pushToast('error', `${mode} thất bại. Mở “Chuyển tệp” để xem chi tiết.`);
      } else if (job.status === 'canceled') {
        pushToast('info', `Đã hủy tác vụ ${mode.toLowerCase()}.`);
      }
    },
    [refreshQuotas, refreshAccounts, pushToast],
  );

  const transfers = useTransfers(api, serverReady, handleJobFinished);
  const { applyJob, reload: reloadTransfers } = transfers;

  // Account cards and the job list are refreshed on demand only (no polling while idle).
  const lastRefreshRef = useRef(0);
  const refreshAll = useCallback(
    (force: boolean) => {
      const now = Date.now();
      // Focus and visibilitychange usually fire together when the user comes back.
      if (!force && now - lastRefreshRef.current < 2000) return;
      lastRefreshRef.current = now;
      if (server.kind === 'ready') {
        refreshAccounts();
        reloadTransfers();
      } else if (server.kind === 'unreachable' || server.kind === 'error') {
        retryServer();
      }
    },
    [server.kind, refreshAccounts, reloadTransfers, retryServer],
  );

  useEffect(() => {
    const onFocus = (): void => refreshAll(false);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refreshAll(false);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshAll]);

  // Failed API calls anywhere in the app: an expired session shows the reload banner; Google
  // rejecting a token refreshes the account cards (only while one still looks connected, so a
  // broken account's own quota error cannot loop).
  useEffect(
    () =>
      signals.subscribe((error) => {
        if (error.code === CLIENT_ERROR_CODES.sessionExpired) {
          markSessionExpired();
        } else if (
          error.code === API_ERROR_CODES.needsReconnect &&
          accountsRef.current.some((account) => account.status === 'connected')
        ) {
          refreshAccounts();
        }
      }),
    [signals, markSessionExpired, refreshAccounts],
  );

  const listingVersion = useCallback(
    (accountId: string) => listingVersions[accountId] ?? 0,
    [listingVersions],
  );

  const handleTransferCreated = useCallback(
    (job: TransferJob) => {
      applyJob(job);
      setDrawerOpen(true);
    },
    [applyJob],
  );

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    drawerToggleRef.current?.focus();
  }, []);

  const configured = server.kind === 'ready' && server.status.configured;
  const addDisabledReason =
    server.kind === 'unreachable'
      ? 'Không kết nối được máy chủ nên chưa thể thêm tài khoản.'
      : server.kind === 'ready' && !server.status.configured
        ? 'Cần hoàn tất thiết lập Google OAuth (xem thông báo phía trên) trước khi thêm tài khoản.'
        : null;

  return (
    <div className={`app${drawerOpen ? ' app--drawer' : ''}`}>
      <a className="skip-link" href="#main">
        Bỏ qua, tới nội dung chính
      </a>
      <header className="topbar">
        <div className="topbar__brand">
          <h1>DriveHop</h1>
          {isMock && (
            <span className="tag tag--mock" title="Dữ liệu giả lập trong bộ nhớ, không gọi máy chủ">
              Chế độ giả lập
            </span>
          )}
        </div>
        <nav className="topbar__nav" aria-label="Điều hướng chính">
          <a
            href={VIEW_HASHES.overview}
            className="tab"
            aria-current={view === 'overview' ? 'page' : undefined}
          >
            Tổng quan
          </a>
          <a
            href={VIEW_HASHES.files}
            className="tab"
            aria-current={view === 'files' ? 'page' : undefined}
          >
            Trình duyệt tệp
          </a>
        </nav>
        <button
          type="button"
          className="button topbar__refresh"
          disabled={!serverReady}
          title="Tải lại danh sách tài khoản và tác vụ"
          onClick={() => refreshAll(true)}
        >
          Làm mới
        </button>
        <button
          ref={drawerToggleRef}
          type="button"
          className="button topbar__transfers"
          aria-expanded={drawerOpen}
          aria-controls="transfers-drawer"
          disabled={!serverReady}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          Chuyển tệp
          {transfers.activeCount > 0 && (
            <span className="count-badge">
              <span aria-hidden="true">{transfers.activeCount}</span>
              <span className="visually-hidden">, {transfers.activeCount} tác vụ đang chạy</span>
            </span>
          )}
        </button>
      </header>

      <main id="main" className="app__main" tabIndex={-1}>
        <SetupBanner server={server} onRetry={retryServer} />
        {server.kind === 'loading' && (
          <p className="state" role="status">
            Đang kết nối máy chủ DriveHop…
          </p>
        )}
        {serverReady && (
          <>
            <div hidden={view !== 'overview'}>
              <Overview
                accountsState={accountsState}
                canAddAccount={configured}
                addDisabledReason={addDisabledReason}
                pushToast={pushToast}
              />
            </div>
            {filesVisited && (
              <div hidden={view !== 'files'}>
                <FileBrowser
                  accounts={accountsState.accounts}
                  accountsLoading={accountsState.loadState === 'loading'}
                  listingVersion={listingVersion}
                  onTransferCreated={handleTransferCreated}
                  pushToast={pushToast}
                />
              </div>
            )}
          </>
        )}
      </main>

      <div id="transfers-drawer">
        {drawerOpen && (
          <TransfersDrawer
            transfers={transfers}
            accounts={accountsState.accounts}
            onClose={closeDrawer}
            pushToast={pushToast}
          />
        )}
      </div>

      <ToastList toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
