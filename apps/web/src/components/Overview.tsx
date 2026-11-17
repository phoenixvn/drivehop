import { useState } from 'react';
import { GOOGLE_LIMITS } from '@multicloud/shared';
import type { AccountWithQuota, Quota } from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import type { AccountsState, QuotaLoadState } from '../hooks/useServer.ts';
import { ACCOUNT_STATUS_LABELS, apiErrorText, formatBytes, percent } from '../lib/format.ts';
import { Dialog } from './Dialog.tsx';
import type { PushToast } from './Toasts.tsx';

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
    return quota.trashBytes ? <p className="quota__text">Thùng rác: {formatBytes(quota.trashBytes)}</p> : null;
  }
  const trash = Math.min(quota.trashBytes ?? 0, quota.driveBytes);
  const files = quota.driveBytes - trash;
  const split = quota.gmailBytes !== undefined && quota.photosBytes !== undefined;
  const rest = Math.max(0, quota.usedBytes - quota.driveBytes);
  const other = split ? (quota.gmailBytes ?? 0) + (quota.photosBytes ?? 0) : rest;
  // Google's per-service numbers do not always add up to the total (seen on large accounts).
  const unknown = split ? Math.max(0, rest - other) : 0;
  const rows: { key: string; label: string; bytes: number }[] = [
    { key: 'drive', label: 'Tệp trên Drive', bytes: files },
    { key: 'trash', label: 'Thùng rác Drive', bytes: trash },
    ...(split
      ? [
          { key: 'gmail', label: 'Gmail', bytes: quota.gmailBytes ?? 0 },
          { key: 'photos', label: 'Google Photos', bytes: quota.photosBytes ?? 0 },
        ]
      : [{ key: 'other', label: 'Gmail + Google Photos', bytes: other }]),
    ...(unknown >= quota.usedBytes * 0.01 && unknown > 0
      ? [{ key: 'unknown', label: 'Khác (Google không ghi rõ)', bytes: unknown }]
      : []),
  ];
  const near = quota.totalBytes !== null && quota.usedBytes >= quota.totalBytes * 0.8;
  const hint =
    !near || quota.usedBytes === 0
      ? null
      : trash >= quota.usedBytes * 0.25
        ? 'Phần lớn nằm trong thùng rác: xóa vĩnh viễn thùng rác sẽ giải phóng chỗ.'
        : other >= quota.usedBytes * 0.5
          ? 'Phần lớn là Gmail / Google Photos: cần dọn ở Gmail hoặc Google Photos, dời Drive không đủ.'
          : files >= quota.usedBytes * 0.5
            ? 'Phần lớn là tệp trên Drive: dời sang tài khoản còn trống rồi giải phóng dung lượng.'
            : null;
  return (
    <>
      <ul className="quota__breakdown" aria-label="Dung lượng theo nguồn">
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
        {state === 'error' ? 'Không tải được thông tin dung lượng.' : 'Đang tải dung lượng…'}
      </p>
    );
  }
  if (quota.totalBytes === null) {
    return (
      <p className="quota__text">
        Đã dùng <strong>{formatBytes(quota.usedBytes)}</strong> · Không giới hạn dung lượng
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
        aria-label={`Dung lượng đã dùng của ${account.email}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={`${formatBytes(quota.usedBytes)} trên ${formatBytes(quota.totalBytes)}`}
      >
        <div className="progress__bar" style={{ width: `${used}%` }} />
      </div>
      <p className="quota__text">
        Đã dùng <strong>{formatBytes(quota.usedBytes)}</strong> / {formatBytes(quota.totalBytes)} (
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
        pushToast('success', `Đã gỡ liên kết ${account.email} khỏi DriveHop.`);
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
          <h2 id="overview-title">Tổng quan</h2>
          <p className="muted">
            {loadState === 'ready'
              ? `${accounts.length} tài khoản Google Drive đã liên kết`
              : 'Các tài khoản Google Drive đã liên kết'}
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
            + Thêm tài khoản Google
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
          Đang tải danh sách tài khoản…
        </p>
      )}
      {loadState === 'error' && (
        <div className="state state--error" role="alert">
          <p>Không tải được danh sách tài khoản. {error}</p>
          <button type="button" className="button" onClick={reload}>
            Thử lại
          </button>
        </div>
      )}
      {loadState === 'ready' && accounts.length === 0 && (
        <div className="state">
          <p>
            <strong>Chưa có tài khoản nào.</strong>
          </p>
          <p className="muted">Bấm “Thêm tài khoản Google” để liên kết tài khoản đầu tiên.</p>
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
                  <span className="card__email">{account.email}</span>
                </div>
                <span className={`badge badge--${account.status}`}>
                  {ACCOUNT_STATUS_LABELS[account.status]}
                </span>
              </div>
              <QuotaBlock account={account} state={quotaStates[account.id]} />
              {account.status === 'needs_reconnect' && (
                <p className="small card__note">
                  Quyền truy cập đã hết hạn hoặc bị thu hồi. Hãy kết nối lại và chọn đúng tài khoản{' '}
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
                    Kết nối lại
                  </button>
                )}
                <button
                  type="button"
                  className="button button--danger-outline"
                  aria-label={`Xóa ${account.email} khỏi DriveHop`}
                  onClick={() => {
                    setDeleteError(null);
                    setPendingDelete(account);
                  }}
                >
                  Xóa
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <aside className="info-box" aria-labelledby="limits-title">
        <h3 id="limits-title">Giới hạn của Google Drive</h3>
        <ul>
          <li>
            Mỗi tài khoản chỉ được tải lên và sao chép tổng cộng <strong>{dailyLimit} mỗi ngày</strong>{' '}
            (tính gộp tải lên và sao chép, trong 24 giờ).
          </li>
          <li>
            Kích thước tối đa của một tệp có thể sao chép là <strong>{maxFile}</strong>.
          </li>
        </ul>
        <p className="muted small">
          Khi chạm giới hạn, các mục còn lại sẽ báo lỗi và có thể thử lại sau trong bảng “Chuyển tệp”.
        </p>
      </aside>

      {pendingDelete && (
        <Dialog
          title="Xóa tài khoản khỏi DriveHop?"
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
                Hủy
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? 'Đang xóa…' : 'Xóa liên kết'}
              </button>
            </>
          }
        >
          <p>
            Thao tác này chỉ gỡ liên kết của <strong>{pendingDelete.email}</strong> bên trong
            DriveHop.
          </p>
          <p>
            <strong>Không có tệp hay thư mục nào trong Google Drive bị xóa hoặc thay đổi.</strong>{' '}
            Bạn có thể thêm lại tài khoản này bất cứ lúc nào.
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
