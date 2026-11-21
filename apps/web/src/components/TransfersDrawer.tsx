import { useEffect, useId, useRef, useState } from 'react';
import { isTerminalJobStatus } from '@multicloud/shared';
import type { AccountWithQuota, TransferItem, TransferJob } from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import type { ItemsState, TransfersState } from '../hooks/useTransfers.ts';
import {
  ITEM_STATUS_LABELS,
  JOB_STATUS_LABELS,
  MODE_LABELS,
  QUEUED_JOB_NOTE,
  apiErrorText,
  canRetryJob,
  formatBytes,
  formatCount,
  formatDate,
  friendlyItemError,
  friendlyItemWarning,
  friendlyJobError,
  percent,
} from '../lib/format.ts';
import { strings } from '../lib/i18n.ts';
import { Dialog } from './Dialog.tsx';
import type { PushToast } from './Toasts.tsx';

const items = (n: number): string => `${formatCount(n)} ${n === 1 ? 'item' : 'items'}`;

const S = strings({
  en: {
    unknownSize: 'Unknown size',
    verified: ' · Verified',
    originalPurged: ' · Original deleted forever',
    originalTrashed: ' · Original moved to trash',
    note: 'Note:',
    loadingItems: 'Loading items…',
    itemsLoadFailed: "Couldn't load the items.",
    retry: 'Retry',
    noItems: 'No items.',
    largeJob: (shown: number, omitted: number) =>
      `Large job: showing only ${items(shown)} (the ones you selected, failed, running and those with a note come first); ${formatCount(omitted)} more ${omitted === 1 ? "isn't" : "aren't"} shown here.`,
    cancelFailed: "Couldn't cancel the job.",
    retryFailed: "Couldn't retry.",
    purgeKept: (n: number) => `${items(n)} kept (see details)`,
    purgeFailed: (n: number) => `${items(n)} couldn't be deleted yet, please retry`,
    purgeDone: (n: number, email: string, extra: string) =>
      `Deleted ${formatCount(n)} ${n === 1 ? 'original' : 'originals'} forever from ${email}.${extra} Google may take a few minutes to update storage.`,
    to: ' to ',
    progressLabel: (mode: string) => `${mode} progress`,
    itemsProgress: (done: number, total: number) =>
      `${formatCount(done)}/${formatCount(total)} ${total === 1 ? 'item' : 'items'}`,
    failedItems: (n: number) => ` · ${formatCount(n)} failed`,
    finished: (date: string) => ` · Finished ${date}`,
    trashedNote: (n: number, email: string) => (
      <>
        {formatCount(n)} moved {n === 1 ? 'original is' : 'originals are'} in the{' '}
        <strong>trash</strong> of {email} and{' '}
        <strong>{n === 1 ? 'still uses' : 'still use'} storage</strong> until deleted forever
        (Google empties the trash after 30 days).
      </>
    ),
    hideDetails: 'Hide details',
    showDetails: 'Show details',
    canceling: 'Canceling…',
    cancel: 'Cancel',
    retryTitle: 'Re-run the failed or canceled items',
    retrying: 'Retrying…',
    purgeTitle: 'Delete the moved originals forever to free up space in the source account',
    purgingForever: 'Deleting forever…',
    freeUpSpace: 'Free up space',
    purgeDialogTitle: 'Delete originals forever?',
    back: 'Back',
    deleting: 'Deleting…',
    deleteForeverN: (n: number) => `Delete ${items(n)} forever`,
    purgeIntro: (n: number, email: string) => (
      <>
        You're about to{' '}
        <strong>
          delete forever {formatCount(n)} original {n === 1 ? 'item' : 'items'}
        </strong>{' '}
        that this job moved to the trash of <strong>{email}</strong>, to free up space.
      </>
    ),
    purgeCopiesSafe: (email: string) => (
      <>
        Their copies in <strong>{email}</strong> were verified and won't be touched.
      </>
    ),
    purgeRecheck:
      'Before deleting each item, DriveHop checks again: the copy in the destination must still exist, and the original must still be in the trash (items you restored are kept).',
    purgeOthers: 'Anything else in the trash (not moved there by this job) is left alone.',
    irreversibleLabel: "Can't be undone:",
    irreversibleText: " once deleted, the originals can't be recovered.",
    deletedAccount: (id: string) => `Deleted account (${id})`,
    title: 'Transfers',
    closeLabel: 'Close transfers panel',
    liveLost:
      'Lost the live update connection, trying to reconnect (the list still reloads periodically)…',
    reloadList: 'Reload list',
    loadingJobs: 'Loading jobs…',
    jobsLoadFailed: "Couldn't load jobs.",
    noJobs: 'No jobs yet. Drag files between the two panes in “File browser” to start.',
  },
  vi: {
    unknownSize: 'Không rõ kích thước',
    verified: ' · Đã kiểm tra',
    originalPurged: ' · Bản gốc đã xóa vĩnh viễn',
    originalTrashed: ' · Bản gốc đã vào thùng rác',
    note: 'Lưu ý:',
    loadingItems: 'Đang tải danh sách mục…',
    itemsLoadFailed: 'Không tải được danh sách mục.',
    retry: 'Thử lại',
    noItems: 'Không có mục nào.',
    largeJob: (shown: number, omitted: number) =>
      `Tác vụ lớn: chỉ hiện ${shown} mục (các mục bạn chọn, mục lỗi, mục đang chạy và mục có lưu ý được ưu tiên); ${omitted} mục khác không hiện ở đây.`,
    cancelFailed: 'Không hủy được tác vụ.',
    retryFailed: 'Không thử lại được.',
    purgeKept: (n: number) => `${n} mục được giữ lại (xem chi tiết)`,
    purgeFailed: (n: number) => `${n} mục chưa xóa được, hãy thử lại`,
    purgeDone: (n: number, email: string, extra: string) =>
      `Đã xóa vĩnh viễn ${n} bản gốc khỏi ${email}.${extra} Google có thể cần vài phút để cập nhật dung lượng.`,
    to: ' sang ',
    progressLabel: (mode: string) => `Tiến độ ${mode.toLowerCase()}`,
    itemsProgress: (done: number, total: number) => `${done}/${total} mục`,
    failedItems: (n: number) => ` · ${n} mục lỗi`,
    finished: (date: string) => ` · Kết thúc ${date}`,
    trashedNote: (n: number, email: string) => (
      <>
        {n} mục gốc đã chuyển xong đang nằm trong <strong>thùng rác</strong> của {email} và{' '}
        <strong>vẫn chiếm dung lượng</strong> cho tới khi bị xóa vĩnh viễn (Google tự xóa sau 30
        ngày).
      </>
    ),
    hideDetails: 'Ẩn chi tiết',
    showDetails: 'Xem chi tiết',
    canceling: 'Đang hủy…',
    cancel: 'Hủy',
    retryTitle: 'Chạy lại các mục bị lỗi hoặc đã hủy',
    retrying: 'Đang thử lại…',
    purgeTitle: 'Xóa vĩnh viễn các bản gốc đã chuyển xong để giải phóng dung lượng tài khoản nguồn',
    purgingForever: 'Đang xóa vĩnh viễn…',
    freeUpSpace: 'Giải phóng dung lượng',
    purgeDialogTitle: 'Xóa vĩnh viễn bản gốc?',
    back: 'Quay lại',
    deleting: 'Đang xóa…',
    deleteForeverN: (n: number) => `Xóa vĩnh viễn ${n} mục`,
    purgeIntro: (n: number, email: string) => (
      <>
        Bạn sắp <strong>xóa vĩnh viễn {n} mục gốc</strong> mà tác vụ này đã chuyển vào thùng rác
        của <strong>{email}</strong>, để giải phóng dung lượng.
      </>
    ),
    purgeCopiesSafe: (email: string) => (
      <>
        Bản sao của chúng ở <strong>{email}</strong> đã được kiểm tra và không bị đụng tới.
      </>
    ),
    purgeRecheck:
      'Trước khi xóa từng mục, DriveHop kiểm tra lại: bản sao ở đích phải còn, và bản gốc phải vẫn nằm trong thùng rác (mục bạn đã khôi phục sẽ được giữ nguyên).',
    purgeOthers: 'Các thứ khác trong thùng rác (không do tác vụ này chuyển vào) không bị đụng tới.',
    irreversibleLabel: 'Không thể hoàn tác:',
    irreversibleText: ' sau khi xóa, bản gốc không khôi phục được nữa.',
    deletedAccount: (id: string) => `Tài khoản đã xóa (${id})`,
    title: 'Chuyển tệp',
    closeLabel: 'Đóng bảng chuyển tệp',
    liveLost:
      'Mất kết nối cập nhật trực tiếp, đang thử kết nối lại (danh sách vẫn được tải lại định kỳ)…',
    reloadList: 'Tải lại danh sách',
    loadingJobs: 'Đang tải danh sách tác vụ…',
    jobsLoadFailed: 'Không tải được danh sách tác vụ.',
    noJobs: 'Chưa có tác vụ nào. Kéo tệp giữa hai ngăn trong “Trình duyệt tệp” để bắt đầu.',
  },
});

interface TransfersDrawerProps {
  transfers: TransfersState;
  accounts: readonly AccountWithQuota[];
  onClose: () => void;
  pushToast: PushToast;
}

function ItemRow({ item }: { item: TransferItem }) {
  const error = item.status === 'failed' || item.error ? friendlyItemError(item.error) : null;
  const warning = friendlyItemWarning(item.warning);
  return (
    <li className="job-item">
      <div className="job-item__line">
        <span aria-hidden="true">{item.isFolder ? '📁' : '📄'}</span>
        <span className="job-item__name" title={item.name}>
          {item.name}
        </span>
        <span className={`chip chip--item-${item.status}`}>
          {ITEM_STATUS_LABELS[item.status]}
          {item.status === 'done' && item.verified ? ' ✓' : ''}
        </span>
      </div>
      <div className="job-item__meta small muted">
        {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : S.unknownSize}
        {item.status === 'done' && item.verified ? S.verified : ''}
        {item.sourcePurged ? S.originalPurged : item.sourceTrashed ? S.originalTrashed : ''}
      </div>
      {error && (
        <p className="job-item__error small">
          {error.text}
          {error.detail && <span className="job-item__detail"> ({error.detail})</span>}
        </p>
      )}
      {warning && (
        <p className="job-item__warning small">
          <strong>{S.note}</strong> {warning.text}
          {warning.detail && <span className="job-item__detail"> ({warning.detail})</span>}
        </p>
      )}
    </li>
  );
}

function ItemList({ state, onRetryLoad }: { state: ItemsState | undefined; onRetryLoad: () => void }) {
  if (!state || state.kind === 'loading') {
    return (
      <p className="muted small" role="status">
        {S.loadingItems}
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="small" role="alert">
        <p className="error-text">{S.itemsLoadFailed} {state.message}</p>
        <button type="button" className="button button--small" onClick={onRetryLoad}>
          {S.retry}
        </button>
      </div>
    );
  }
  if (state.items.length === 0) return <p className="muted small">{S.noItems}</p>;
  return (
    <>
      {state.omitted !== undefined && (
        <p className="muted small">
          {S.largeJob(state.items.length, state.omitted)}
        </p>
      )}
      <ul className="job-items">
        {state.items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
    </>
  );
}

interface JobCardProps {
  job: TransferJob;
  emailOf: (accountId: string) => string;
  itemsState: ItemsState | undefined;
  loadItems: (jobId: string) => void;
  applyJob: (job: TransferJob) => void;
  pushToast: PushToast;
}

function JobCard({ job, emailOf, itemsState, loadItems, applyJob, pushToast }: JobCardProps) {
  const api = useApi();
  const itemsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [purgeStep, setPurgeStep] = useState<'idle' | 'confirm' | 'running'>('idle');
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const { totals } = job;
  const terminal = isTerminalJobStatus(job.status);
  const canCancel = !terminal;
  const canRetry = canRetryJob(job);
  // 'canceled' needs no explanation beyond its status chip.
  const reason = terminal && job.status !== 'canceled' ? friendlyJobError(job.error) : null;
  const byBytes = totals.bytesTotal > 0;
  const progress = terminal && job.status === 'completed'
    ? 100
    : byBytes
      ? percent(totals.bytesDone, totals.bytesTotal)
      : percent(totals.done, totals.items);

  const run = (action: 'cancel' | 'retry'): void => {
    setBusy(action);
    const call = action === 'cancel' ? api.cancelTransfer(job.id) : api.retryFailedTransfer(job.id);
    call.then(
      (updated) => {
        setBusy(null);
        // Cancel answers promptly, possibly while the job is still winding down; that snapshot
        // must not overwrite a `job.finished` event that arrived first. Events report the rest.
        if (action === 'retry' || isTerminalJobStatus(updated.status)) applyJob(updated);
        if (expanded) loadItems(job.id);
      },
      (cause: unknown) => {
        setBusy(null);
        pushToast(
          'error',
          `${action === 'cancel' ? S.cancelFailed : S.retryFailed} ${apiErrorText(cause)}`,
        );
      },
    );
  };

  const trashedCount = job.trash?.trashed ?? 0;
  const canPurge = job.mode === 'move' && terminal && trashedCount > 0;

  // Each request deletes one bounded batch; keep going while it makes progress.
  const purge = async (): Promise<void> => {
    setPurgeStep('running');
    setPurgeError(null);
    let purged = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (;;) {
        const result = await api.purgeTrashedSources(job.id);
        purged += result.purged;
        skipped += result.skipped;
        failed += result.failed;
        applyJob(result.job);
        if (result.remaining === 0 || result.purged + result.skipped === 0) break;
      }
    } catch (cause: unknown) {
      setPurgeStep('confirm');
      setPurgeError(apiErrorText(cause));
      return;
    }
    setPurgeStep('idle');
    if (expanded) loadItems(job.id);
    const extra = [
      skipped > 0 ? S.purgeKept(skipped) : '',
      failed > 0 ? S.purgeFailed(failed) : '',
    ].filter(Boolean);
    pushToast(
      failed > 0 ? 'error' : 'success',
      S.purgeDone(
        purged,
        emailOf(job.sourceAccountId),
        extra.length > 0 ? ` ${extra.join('; ')}.` : '',
      ),
    );
  };

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadItems(job.id);
  };

  return (
    <li className="job">
      <div className="job__head">
        <span className={`chip chip--mode-${job.mode}`}>{MODE_LABELS[job.mode]}</span>
        <span className={`chip chip--job-${job.status}`}>{JOB_STATUS_LABELS[job.status]}</span>
        <span className="muted small job__date">{formatDate(job.createdAt)}</span>
      </div>
      <p className="job__route">
        <span className="job__email" title={emailOf(job.sourceAccountId)}>
          {emailOf(job.sourceAccountId)}
        </span>
        <span aria-hidden="true"> → </span>
        <span className="visually-hidden">{S.to}</span>
        <span className="job__email" title={emailOf(job.destAccountId)}>
          {emailOf(job.destAccountId)}
        </span>
      </p>
      <div
        className={`progress progress--job-${job.status}`}
        role="progressbar"
        aria-label={S.progressLabel(MODE_LABELS[job.mode])}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div className="progress__bar" style={{ width: `${progress}%` }} />
      </div>
      <p className="small job__numbers">
        {S.itemsProgress(totals.done, totals.items)}
        {byBytes ? ` · ${formatBytes(totals.bytesDone)} / ${formatBytes(totals.bytesTotal)}` : ''}
        {totals.failed > 0 && <span className="error-text">{S.failedItems(totals.failed)}</span>}
        {job.finishedAt ? S.finished(formatDate(job.finishedAt)) : ''}
      </p>
      {job.status === 'queued' && (
        <p className="job__queued small muted" role="status">
          {QUEUED_JOB_NOTE}
        </p>
      )}
      {reason && (
        <p className="job__reason small">
          {reason.text}
          {reason.detail && <span className="job-item__detail"> ({reason.detail})</span>}
        </p>
      )}
      {canPurge && (
        <p className="job__reason small">
          {S.trashedNote(trashedCount, emailOf(job.sourceAccountId))}
        </p>
      )}
      <div className="job__actions">
        <button
          type="button"
          className="button button--small"
          aria-expanded={expanded}
          aria-controls={itemsId}
          onClick={toggle}
        >
          {expanded ? S.hideDetails : S.showDetails}
        </button>
        {canCancel && (
          <button
            type="button"
            className="button button--small button--danger-outline"
            onClick={() => run('cancel')}
            disabled={busy !== null}
          >
            {busy === 'cancel' ? S.canceling : S.cancel}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            className="button button--small"
            onClick={() => run('retry')}
            disabled={busy !== null}
            title={S.retryTitle}
          >
            {busy === 'retry' ? S.retrying : S.retry}
          </button>
        )}
        {canPurge && (
          <button
            type="button"
            className="button button--small button--danger-outline"
            onClick={() => {
              setPurgeError(null);
              setPurgeStep('confirm');
            }}
            disabled={busy !== null || purgeStep === 'running'}
            title={S.purgeTitle}
          >
            {purgeStep === 'running' ? S.purgingForever : S.freeUpSpace}
          </button>
        )}
      </div>
      {purgeStep !== 'idle' && (
        <Dialog
          title={S.purgeDialogTitle}
          onClose={() => setPurgeStep('idle')}
          busy={purgeStep === 'running'}
          actions={
            <>
              <button
                type="button"
                className="button"
                onClick={() => setPurgeStep('idle')}
                disabled={purgeStep === 'running'}
                data-autofocus
              >
                {S.back}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => void purge()}
                disabled={purgeStep === 'running'}
              >
                {purgeStep === 'running' ? S.deleting : S.deleteForeverN(trashedCount)}
              </button>
            </>
          }
        >
          <p>{S.purgeIntro(trashedCount, emailOf(job.sourceAccountId))}</p>
          <ul className="plain-list">
            <li>{S.purgeCopiesSafe(emailOf(job.destAccountId))}</li>
            <li>{S.purgeRecheck}</li>
            <li>{S.purgeOthers}</li>
            <li>
              <strong>{S.irreversibleLabel}</strong>
              {S.irreversibleText}
            </li>
          </ul>
          {purgeError && (
            <p className="error-text" role="alert">
              {purgeError}
            </p>
          )}
        </Dialog>
      )}
      <div id={itemsId} hidden={!expanded} className="job__items">
        {expanded && <ItemList state={itemsState} onRetryLoad={() => loadItems(job.id)} />}
      </div>
    </li>
  );
}

export function TransfersDrawer({ transfers, accounts, onClose, pushToast }: TransfersDrawerProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const emailOf = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.email ?? S.deletedAccount(accountId);

  return (
    <aside
      className="drawer"
      aria-labelledby="drawer-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="drawer__header">
        <h2 id="drawer-title" ref={titleRef} tabIndex={-1}>
          {S.title}
        </h2>
        <button type="button" className="icon-button" aria-label={S.closeLabel} onClick={onClose}>
          ×
        </button>
      </header>

      {!transfers.live && transfers.loadState === 'ready' && (
        <p className="drawer__notice small" role="status">
          {S.liveLost}{' '}
          <button type="button" className="link-button" onClick={transfers.reload}>
            {S.reloadList}
          </button>
        </p>
      )}

      <div className="drawer__body">
        {transfers.loadState === 'loading' && (
          <p className="state" role="status">
            {S.loadingJobs}
          </p>
        )}
        {transfers.loadState === 'error' && (
          <div className="state state--error" role="alert">
            <p>{S.jobsLoadFailed} {transfers.error}</p>
            <button type="button" className="button" onClick={transfers.reload}>
              {S.retry}
            </button>
          </div>
        )}
        {transfers.loadState === 'ready' && transfers.jobs.length === 0 && (
          <p className="state">
            {S.noJobs}
          </p>
        )}
        {transfers.jobs.length > 0 && (
          <ul className="jobs">
            {transfers.jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                emailOf={emailOf}
                itemsState={transfers.itemsByJob[job.id]}
                loadItems={transfers.loadItems}
                applyJob={transfers.applyJob}
                pushToast={pushToast}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
