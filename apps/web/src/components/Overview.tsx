import { useState } from 'react';
import { GOOGLE_LIMITS } from '@multicloud/shared';
import type { AccountWithQuota, Quota } from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import type { AccountsState, QuotaLoadState } from '../hooks/useServer.ts';
import { ACCOUNT_STATUS_LABELS, apiErrorText, formatBytes, formatCount, percent } from '../lib/format.ts';
import { strings } from '../lib/i18n.ts';
import { Dialog } from './Dialog.tsx';
import type { PushToast } from './Toasts.tsx';

const S = strings({
  en: {
    trash: (size: string) => `Trash: ${size}`,
    driveFiles: 'Drive files',
    driveTrash: 'Drive trash',
    otherUnknown: 'Other (not itemized by Google)',
    hintTrash: 'Most of it is in the trash: deleting the trash forever will free up space.',
    hintOther:
      "Most of it is Gmail / Google Photos: clean up Gmail or Google Photos; moving Drive files won't be enough.",
    hintFiles: 'Most of it is Drive files: move them to an account with free space, then free up space.',
    breakdownLabel: 'Storage by source',
    quotaError: "Couldn't load storage info.",
    quotaLoading: 'Loading storage…',
    used: 'Used',
    unlimited: 'Unlimited storage',
    usedBy: (email: string) => `Storage used by ${email}`,
    usedOf: (used: string, total: string) => `${used} of ${total}`,
    unlinked: (email: string) => `Unlinked ${email} from DriveHop.`,
    title: 'Overview',
    linkedCount: (n: number) =>
      `${formatCount(n)} linked Google Drive ${n === 1 ? 'account' : 'accounts'}`,
    linkedAccounts: 'Linked Google Drive accounts',
    addAccount: '+ Add Google account',
    loadingAccounts: 'Loading accounts…',
    loadFailed: "Couldn't load the account list.",
    retry: 'Retry',
    noAccounts: 'No accounts yet.',
    noAccountsHint: 'Click “Add Google account” to link your first account.',
    reconnectNote: 'Access expired or was revoked. Reconnect and choose the account',
    reconnect: 'Reconnect',
    removeLabel: (email: string) => `Remove ${email} from DriveHop`,
    remove: 'Remove',
    limitsTitle: 'Google Drive limits',
    dailyBefore: 'Each account can upload and copy at most',
    dailyAmount: (limit: string) => `${limit} per day`,
    dailyAfter: '(uploads and copies combined, over 24 hours).',
    maxFile: 'The largest single file that can be copied is',
    limitsNote:
      'When a limit is hit, the remaining items fail and can be retried later from the “Transfers” panel.',
    confirmTitle: 'Remove account from DriveHop?',
    cancel: 'Cancel',
    unlinking: 'Unlinking…',
    unlink: 'Unlink',
    confirmBefore: 'This only unlinks',
    confirmAfter: 'inside DriveHop.',
    nothingDeleted: 'No files or folders in Google Drive are deleted or changed.',
    canReAdd: 'You can add this account again at any time.',
  },
  vi: {
    trash: (size: string) => `Thùng rác: ${size}`,
    driveFiles: 'Tệp trên Drive',
    driveTrash: 'Thùng rác Drive',
    otherUnknown: 'Khác (Google không ghi rõ)',
    hintTrash: 'Phần lớn nằm trong thùng rác: xóa vĩnh viễn thùng rác sẽ giải phóng chỗ.',
    hintOther:
      'Phần lớn là Gmail / Google Photos: cần dọn ở Gmail hoặc Google Photos, dời Drive không đủ.',
    hintFiles: 'Phần lớn là tệp trên Drive: dời sang tài khoản còn trống rồi giải phóng dung lượng.',
    breakdownLabel: 'Dung lượng theo nguồn',
    quotaError: 'Không tải được thông tin dung lượng.',
    quotaLoading: 'Đang tải dung lượng…',
    used: 'Đã dùng',
    unlimited: 'Không giới hạn dung lượng',
    usedBy: (email: string) => `Dung lượng đã dùng của ${email}`,
    usedOf: (used: string, total: string) => `${used} trên ${total}`,
    unlinked: (email: string) => `Đã gỡ liên kết ${email} khỏi DriveHop.`,
    title: 'Tổng quan',
    linkedCount: (n: number) => `${formatCount(n)} tài khoản Google Drive đã liên kết`,
    linkedAccounts: 'Các tài khoản Google Drive đã liên kết',
    addAccount: '+ Thêm tài khoản Google',
    loadingAccounts: 'Đang tải danh sách tài khoản…',
    loadFailed: 'Không tải được danh sách tài khoản.',
    retry: 'Thử lại',
    noAccounts: 'Chưa có tài khoản nào.',
    noAccountsHint: 'Bấm “Thêm tài khoản Google” để liên kết tài khoản đầu tiên.',
    reconnectNote: 'Quyền truy cập đã hết hạn hoặc bị thu hồi. Hãy kết nối lại và chọn đúng tài khoản',
    reconnect: 'Kết nối lại',
    removeLabel: (email: string) => `Xóa ${email} khỏi DriveHop`,
    remove: 'Xóa',
    limitsTitle: 'Giới hạn của Google Drive',
    dailyBefore: 'Mỗi tài khoản chỉ được tải lên và sao chép tổng cộng',
    dailyAmount: (limit: string) => `${limit} mỗi ngày`,
    dailyAfter: '(tính gộp tải lên và sao chép, trong 24 giờ).',
    maxFile: 'Kích thước tối đa của một tệp có thể sao chép là',
    limitsNote:
      'Khi chạm giới hạn, các mục còn lại sẽ báo lỗi và có thể thử lại sau trong bảng “Chuyển tệp”.',
    confirmTitle: 'Xóa tài khoản khỏi DriveHop?',
    cancel: 'Hủy',
    unlinking: 'Đang xóa…',
    unlink: 'Xóa liên kết',
    confirmBefore: 'Thao tác này chỉ gỡ liên kết của',
    confirmAfter: 'bên trong DriveHop.',
    nothingDeleted: 'Không có tệp hay thư mục nào trong Google Drive bị xóa hoặc thay đổi.',
    canReAdd: 'Bạn có thể thêm lại tài khoản này bất cứ lúc nào.',
  },
});

interface OverviewProps {
  accountsState: AccountsState;
  /** False while the server is unreachable or OAuth is not configured. */
  canAddAccount: boolean;
  addDisabledReason: string | null;
  pushToast: PushToast;
}

export function Avatar({ account }: { account: Pick<AccountWithQuota, 'avatarUrl' | 'email' | 'displayName'> }) {
  const [failed, setFailed] = useState(false);
  const initial = (account.displayName || account.email || '?').trim().charAt(0).toUpperCase();
  // Only https image URLs are used (the value comes from Google's profile, stored by the server).
  if (account.avatarUrl && /^https:\/\//i.test(account.avatarUrl) && !failed) {
    return (
      <img
        className="avatar"
        src={account.avatarUrl}
        alt=""
        width={44}
        height={44}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="avatar avatar--fallback" aria-hidden="true">
      {initial}
    </span>
  );
}

/**
 * Where the used space is: Drive files, Drive trash, and Gmail + Google Photos (Google reports those
 * two only as one number, the part of the quota not used by Drive).
 */
function QuotaBreakdown({ quota }: { quota: Quota }) {
  if (quota.driveBytes === undefined) {
    return quota.trashBytes ? <p className="quota__text">{S.trash(formatBytes(quota.trashBytes))}</p> : null;
  }
  const trash = Math.min(quota.trashBytes ?? 0, quota.driveBytes);
  const files = quota.driveBytes - trash;
  const split = quota.gmailBytes !== undefined && quota.photosBytes !== undefined;
  const rest = Math.max(0, quota.usedBytes - quota.driveBytes);
  const other = split ? (quota.gmailBytes ?? 0) + (quota.photosBytes ?? 0) : rest;
  // Google's per-service numbers do not always add up to the total (seen on large accounts).
  const unknown = split ? Math.max(0, rest - other) : 0;
  const rows: { key: string; label: string; bytes: number }[] = [
    { key: 'drive', label: S.driveFiles, bytes: files },
    { key: 'trash', label: S.driveTrash, bytes: trash },
    ...(split
      ? [
          { key: 'gmail', label: 'Gmail', bytes: quota.gmailBytes ?? 0 },
          { key: 'photos', label: 'Google Photos', bytes: quota.photosBytes ?? 0 },
        ]
      : [{ key: 'other', label: 'Gmail + Google Photos', bytes: other }]),
    ...(unknown >= quota.usedBytes * 0.01 && unknown > 0
      ? [{ key: 'unknown', label: S.otherUnknown, bytes: unknown }]
      : []),
  ];
  const near = quota.totalBytes !== null && quota.usedBytes >= quota.totalBytes * 0.8;
  const hint =
    !near || quota.usedBytes === 0
      ? null
      : trash >= quota.usedBytes * 0.25
        ? S.hintTrash
        : other >= quota.usedBytes * 0.5
          ? S.hintOther
          : files >= quota.usedBytes * 0.5
            ? S.hintFiles
            : null;
  return (
    <>
      <ul className="quota__breakdown" aria-label={S.breakdownLabel}>
        {rows.map((row) => (
          <li key={row.key}>
            <span className={`quota__dot quota__dot--${row.key}`} aria-hidden="true" />
            <span>{row.label}</span>
            <strong>{formatBytes(row.bytes)}</strong>
          </li>
        ))}
      </ul>
      {hint && <p className="quota__text quota__hint">{hint}</p>}
    </>
  );
}

function QuotaBlock({ account, state }: { account: AccountWithQuota; state: QuotaLoadState | undefined }) {
  const { quota } = account;
  if (!quota) {
    return (
      <p className="muted quota__text">
        {state === 'error' ? S.quotaError : S.quotaLoading}
      </p>
    );
  }
  if (quota.totalBytes === null) {
    return (
      <p className="quota__text">
        {S.used} <strong>{formatBytes(quota.usedBytes)}</strong> · {S.unlimited}
      </p>
    );
  }
  const used = percent(quota.usedBytes, quota.totalBytes);
  const level = used >= 95 ? 'danger' : used >= 80 ? 'warning' : 'ok';
  return (
    <div className="quota">
      <div
        className={`progress progress--${level}`}
        role="progressbar"
        aria-label={S.usedBy(account.email)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={S.usedOf(formatBytes(quota.usedBytes), formatBytes(quota.totalBytes))}
      >
        <div className="progress__bar" style={{ width: `${used}%` }} />
      </div>
      <p className="quota__text">
        {S.used} <strong>{formatBytes(quota.usedBytes)}</strong> / {formatBytes(quota.totalBytes)} (
        {Math.round(used)}%)
      </p>
      <QuotaBreakdown quota={quota} />
    </div>
  );
}

export function Overview({ accountsState, canAddAccount, addDisabledReason, pushToast }: OverviewProps) {
  const api = useApi();
  const { accounts, quotaStates, loadState, error, reload, removeLocal } = accountsState;
  const [pendingDelete, setPendingDelete] = useState<AccountWithQuota | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const startAuth = (): void => {
    // Full-page navigation: the server redirects to Google and later back to this UI.
    window.location.assign(api.authStartUrl());
  };

  const confirmDelete = (): void => {
    if (!pendingDelete) return;
    const account = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    api.deleteAccount(account.id).then(
      () => {
        removeLocal(account.id);
        setDeleting(false);
        setPendingDelete(null);
        pushToast('success', S.unlinked(account.email));
      },
      (cause: unknown) => {
        setDeleting(false);
        setDeleteError(apiErrorText(cause));
      },
    );
  };

  const dailyLimit = formatBytes(GOOGLE_LIMITS.dailyBytesPerAccount);
  const maxFile = formatBytes(GOOGLE_LIMITS.maxCopyFileBytes);

  return (
    <section className="overview" aria-labelledby="overview-title">
      <div className="section-head">
        <div>
          <h2 id="overview-title">{S.title}</h2>
          <p className="muted">
            {loadState === 'ready'
              ? S.linkedCount(accounts.length)
              : S.linkedAccounts}
          </p>
        </div>
        <div className="section-head__actions">
          <button
            type="button"
            className="button button--primary button--large"
            onClick={startAuth}
            disabled={!canAddAccount}
            aria-describedby={addDisabledReason ? 'add-account-reason' : undefined}
          >
            {S.addAccount}
          </button>
          {addDisabledReason && (
            <p id="add-account-reason" className="muted small">
              {addDisabledReason}
            </p>
          )}
        </div>
      </div>

      {loadState === 'loading' && accounts.length === 0 && (
        <p className="state" role="status">
          {S.loadingAccounts}
        </p>
      )}
      {loadState === 'error' && (
        <div className="state state--error" role="alert">
          <p>
            {S.loadFailed} {error}
          </p>
          <button type="button" className="button" onClick={reload}>
            {S.retry}
          </button>
        </div>
      )}
      {loadState === 'ready' && accounts.length === 0 && (
        <div className="state">
          <p>
            <strong>{S.noAccounts}</strong>
          </p>
          <p className="muted">{S.noAccountsHint}</p>
        </div>
      )}

      {accounts.length > 0 && (
        <ul className="cards">
          {accounts.map((account) => (
            <li key={account.id} className="card">
              <div className="card__head">
                <Avatar account={account} />
                <div className="card__identity">
                  <span className="card__name">{account.displayName || account.email}</span>
                  <span className="card__email" title={account.email}>
                    {account.email}
                  </span>
                </div>
                <span className={`badge badge--${account.status}`}>
                  {ACCOUNT_STATUS_LABELS[account.status]}
                </span>
              </div>
              <QuotaBlock account={account} state={quotaStates[account.id]} />
              {account.status === 'needs_reconnect' && (
                <p className="small card__note">
                  {S.reconnectNote}{' '}
                  <strong>{account.email}</strong>.
                </p>
              )}
              <div className="card__actions">
                {account.status === 'needs_reconnect' && (
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={startAuth}
                    disabled={!canAddAccount}
                  >
                    {S.reconnect}
                  </button>
                )}
                <button
                  type="button"
                  className="button button--danger-outline"
                  aria-label={S.removeLabel(account.email)}
                  onClick={() => {
                    setDeleteError(null);
                    setPendingDelete(account);
                  }}
                >
                  {S.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <aside className="info-box" aria-labelledby="limits-title">
        <h3 id="limits-title">{S.limitsTitle}</h3>
        <ul>
          <li>
            {S.dailyBefore} <strong>{S.dailyAmount(dailyLimit)}</strong> {S.dailyAfter}
          </li>
          <li>
            {S.maxFile} <strong>{maxFile}</strong>.
          </li>
        </ul>
        <p className="muted small">
          {S.limitsNote}
        </p>
      </aside>

      {pendingDelete && (
        <Dialog
          title={S.confirmTitle}
          onClose={() => setPendingDelete(null)}
          busy={deleting}
          actions={
            <>
              <button
                type="button"
                className="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                data-autofocus
              >
                {S.cancel}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? S.unlinking : S.unlink}
              </button>
            </>
          }
        >
          <p>
            {S.confirmBefore} <strong>{pendingDelete.email}</strong> {S.confirmAfter}
          </p>
          <p>
            <strong>{S.nothingDeleted}</strong> {S.canReAdd}
          </p>
          {deleteError && (
            <p className="error-text" role="alert">
              {deleteError}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}
