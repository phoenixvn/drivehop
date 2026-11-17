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
  formatDate,
  friendlyItemError,
  friendlyItemWarning,
  friendlyJobError,
  percent,
} from '../lib/format.ts';
import { Dialog } from './Dialog.tsx';
import type { PushToast } from './Toasts.tsx';

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
        {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : 'Không rõ kích thước'}
        {item.status === 'done' && item.verified ? ' · Đã kiểm tra' : ''}
        {item.sourcePurged
          ? ' · Bản gốc đã xóa vĩnh viễn'
          : item.sourceTrashed
            ? ' · Bản gốc đã vào thùng rác'
            : ''}
      </div>
      {error && (
        <p className="job-item__error small">
          {error.text}
          {error.detail && <span className="job-item__detail"> ({error.detail})</span>}
        </p>
      )}
      {warning && (
        <p className="job-item__warning small">
          <strong>Lưu ý:</strong> {warning.text}
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
        Đang tải danh sách mục…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="small" role="alert">
        <p className="error-text">Không tải được danh sách mục. {state.message}</p>
        <button type="button" className="button button--small" onClick={onRetryLoad}>
          Thử lại
        </button>
      </div>
    );
  }
  if (state.items.length === 0) return <p className="muted small">Không có mục nào.</p>;
  return (
    <>
      {state.omitted !== undefined && (
        <p className="muted small">
          Tác vụ lớn: chỉ hiện {state.items.length} mục (các mục bạn chọn, mục lỗi, mục đang chạy
          và mục có lưu ý được ưu tiên); {state.omitted} mục khác không hiện ở đây.
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
          `${action === 'cancel' ? 'Không hủy được tác vụ.' : 'Không thử lại được.'} ${apiErrorText(cause)}`,
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
      skipped > 0 ? `${skipped} mục được giữ lại (xem chi tiết)` : '',
      failed > 0 ? `${failed} mục chưa xóa được, hãy thử lại` : '',
    ].filter(Boolean);
    pushToast(
      failed > 0 ? 'error' : 'success',
      `Đã xóa vĩnh viễn ${purged} bản gốc khỏi ${emailOf(job.sourceAccountId)}.${extra.length > 0 ? ` ${extra.join('; ')}.` : ''} Google có thể cần vài phút để cập nhật dung lượng.`,
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
        <span className="visually-hidden"> sang </span>
        <span className="job__email" title={emailOf(job.destAccountId)}>
          {emailOf(job.destAccountId)}
        </span>
      </p>
      <div
        className={`progress progress--job-${job.status}`}
        role="progressbar"
        aria-label={`Tiến độ ${MODE_LABELS[job.mode].toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div className="progress__bar" style={{ width: `${progress}%` }} />
      </div>
      <p className="small job__numbers">
        {totals.done}/{totals.items} mục
        {byBytes ? ` · ${formatBytes(totals.bytesDone)} / ${formatBytes(totals.bytesTotal)}` : ''}
        {totals.failed > 0 && <span className="error-text"> · {totals.failed} mục lỗi</span>}
        {job.finishedAt ? ` · Kết thúc ${formatDate(job.finishedAt)}` : ''}
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
          {trashedCount} mục gốc đã chuyển xong đang nằm trong <strong>thùng rác</strong> của{' '}
          {emailOf(job.sourceAccountId)} và <strong>vẫn chiếm dung lượng</strong> cho tới khi bị xóa
          vĩnh viễn (Google tự xóa sau 30 ngày).
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
          {expanded ? 'Ẩn chi tiết' : 'Xem chi tiết'}
        </button>
        {canCancel && (
          <button
            type="button"
            className="button button--small button--danger-outline"
            onClick={() => run('cancel')}
            disabled={busy !== null}
          >
            {busy === 'cancel' ? 'Đang hủy…' : 'Hủy'}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            className="button button--small"
            onClick={() => run('retry')}
            disabled={busy !== null}
            title="Chạy lại các mục bị lỗi hoặc đã hủy"
          >
            {busy === 'retry' ? 'Đang thử lại…' : 'Thử lại'}
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
            title="Xóa vĩnh viễn các bản gốc đã chuyển xong để giải phóng dung lượng tài khoản nguồn"
          >
            {purgeStep === 'running' ? 'Đang xóa vĩnh viễn…' : 'Giải phóng dung lượng'}
          </button>
        )}
      </div>
      {purgeStep !== 'idle' && (
        <Dialog
          title="Xóa vĩnh viễn bản gốc?"
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
                Quay lại
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => void purge()}
                disabled={purgeStep === 'running'}
              >
                {purgeStep === 'running' ? 'Đang xóa…' : `Xóa vĩnh viễn ${trashedCount} mục`}
              </button>
            </>
          }
        >
          <p>
            Bạn sắp <strong>xóa vĩnh viễn {trashedCount} mục gốc</strong> mà tác vụ này đã chuyển
            vào thùng rác của <strong>{emailOf(job.sourceAccountId)}</strong>, để giải phóng dung
            lượng.
          </p>
          <ul className="plain-list">
            <li>
              Bản sao của chúng ở <strong>{emailOf(job.destAccountId)}</strong> đã được kiểm tra và
              không bị đụng tới.
            </li>
            <li>
              Trước khi xóa từng mục, DriveHop kiểm tra lại: bản sao ở đích phải còn, và bản gốc
              phải vẫn nằm trong thùng rác (mục bạn đã khôi phục sẽ được giữ nguyên).
            </li>
            <li>Các thứ khác trong thùng rác (không do tác vụ này chuyển vào) không bị đụng tới.</li>
            <li>
              <strong>Không thể hoàn tác:</strong> sau khi xóa, bản gốc không khôi phục được nữa.
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
    accounts.find((account) => account.id === accountId)?.email ?? `Tài khoản đã xóa (${accountId})`;

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
          Chuyển tệp
        </h2>
        <button type="button" className="icon-button" aria-label="Đóng bảng chuyển tệp" onClick={onClose}>
          ×
        </button>
      </header>

      {!transfers.live && transfers.loadState === 'ready' && (
        <p className="drawer__notice small" role="status">
          Mất kết nối cập nhật trực tiếp, đang thử kết nối lại (danh sách vẫn được tải lại định kỳ)…{' '}
          <button type="button" className="link-button" onClick={transfers.reload}>
            Tải lại danh sách
          </button>
        </p>
      )}

      <div className="drawer__body">
        {transfers.loadState === 'loading' && (
          <p className="state" role="status">
            Đang tải danh sách tác vụ…
          </p>
        )}
        {transfers.loadState === 'error' && (
          <div className="state state--error" role="alert">
            <p>Không tải được danh sách tác vụ. {transfers.error}</p>
            <button type="button" className="button" onClick={transfers.reload}>
              Thử lại
            </button>
          </div>
        )}
        {transfers.loadState === 'ready' && transfers.jobs.length === 0 && (
          <p className="state">
            Chưa có tác vụ nào. Kéo tệp giữa hai ngăn trong “Trình duyệt tệp” để bắt đầu.
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
