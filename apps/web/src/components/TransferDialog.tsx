import { useState } from 'react';
import type {
  AccountWithQuota,
  CreateTransferRequest,
  FileEntry,
  TransferJob,
  TransferMode,
} from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import { apiErrorText, fileKind, formatBytes } from '../lib/format.ts';
import { Dialog } from './Dialog.tsx';

export interface TransferPlan {
  sourceAccountId: string;
  sourceFolderPath: string;
  destAccountId: string;
  destFolderId: string;
  destFolderPath: string;
  items: FileEntry[];
  /** Which button gets the initial focus (the "sang bên kia" buttons pre-select a mode). */
  preferredMode: TransferMode | null;
}

interface TransferDialogProps {
  plan: TransferPlan;
  accounts: readonly AccountWithQuota[];
  onClose: () => void;
  onCreated: (job: TransferJob) => void;
}

const PREVIEW_COUNT = 6;

export function TransferDialog({ plan, accounts, onClose, onCreated }: TransferDialogProps) {
  const api = useApi();
  const [step, setStep] = useState<'choose' | 'confirm-move'>('choose');
  const [submitting, setSubmitting] = useState<TransferMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const emailOf = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.email ?? accountId;

  const knownBytes = plan.items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  const unknownCount = plan.items.filter((item) => item.sizeBytes === null).length;
  const folderCount = plan.items.filter((item) => item.isFolder).length;
  const nativeCount = plan.items.filter((item) => item.isGoogleNative).length;
  const crossAccount = plan.sourceAccountId !== plan.destAccountId;

  const submit = (mode: TransferMode): void => {
    const request: CreateTransferRequest = {
      mode,
      sourceAccountId: plan.sourceAccountId,
      destAccountId: plan.destAccountId,
      destFolderId: plan.destFolderId,
      sourceFileIds: plan.items.map((item) => item.id),
    };
    // Only reachable for `move` from the second, explicit confirmation step.
    if (mode === 'move') request.confirmMove = true;
    setSubmitting(mode);
    setError(null);
    api.createTransfer(request).then(
      (job) => {
        setSubmitting(null);
        onCreated(job);
      },
      (cause: unknown) => {
        setSubmitting(null);
        setError(apiErrorText(cause));
      },
    );
  };

  const busy = submitting !== null;

  const summary = (
    <dl className="summary">
      <div>
        <dt>Nguồn</dt>
        <dd>
          <span className="summary__account">{emailOf(plan.sourceAccountId)}</span>
          <span className="summary__path">{plan.sourceFolderPath}</span>
        </dd>
      </div>
      <div>
        <dt>Đích</dt>
        <dd>
          <span className="summary__account">{emailOf(plan.destAccountId)}</span>
          <span className="summary__path">{plan.destFolderPath}</span>
        </dd>
      </div>
      <div>
        <dt>Số mục</dt>
        <dd>
          {plan.items.length} mục
          {folderCount > 0 ? ` (gồm ${folderCount} thư mục)` : ''}
        </dd>
      </div>
      <div>
        <dt>Tổng dung lượng</dt>
        <dd>
          {formatBytes(knownBytes)}
          {unknownCount > 0
            ? ` (chưa tính ${unknownCount} mục không rõ kích thước: thư mục hoặc tệp Google)`
            : ''}
        </dd>
      </div>
    </dl>
  );

  if (step === 'confirm-move') {
    return (
      <Dialog
        key="confirm-move"
        title="Xác nhận di chuyển"
        onClose={onClose}
        busy={busy}
        actions={
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                setError(null);
                setStep('choose');
              }}
              disabled={busy}
              data-autofocus
            >
              Quay lại
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => submit('move')}
              disabled={busy}
            >
              {busy ? 'Đang gửi…' : `Xác nhận di chuyển ${plan.items.length} mục`}
            </button>
          </>
        }
      >
        <p>
          Bạn sắp <strong>di chuyển {plan.items.length} mục</strong> từ{' '}
          <strong>{emailOf(plan.sourceAccountId)}</strong> sang{' '}
          <strong>{emailOf(plan.destAccountId)}</strong>.
        </p>
        <ul className="plain-list">
          <li>Trước tiên, mọi mục được sao chép sang đích và kiểm tra lại (kích thước / mã MD5).</li>
          <li>
            Mỗi mục bạn chọn được xét riêng: một tệp hay thư mục chỉ được chuyển vào{' '}
            <strong>Thùng rác của Google Drive</strong> khi <strong>toàn bộ</strong> nội dung của nó
            đã được sao chép và kiểm tra thành công, và chỉ sau khi mọi bản sao của lượt chạy đã xong.
          </li>
          <li>
            DriveHop <strong>không bao giờ xóa vĩnh viễn</strong> bản gốc: bạn có thể khôi phục
            chúng từ Thùng rác của Drive (lưu ý Google tự dọn Thùng rác sau 30 ngày).
          </li>
          <li>
            Mục nào có lỗi (kể cả thư mục chứa một tệp không sao chép được) được giữ nguyên ở tài
            khoản nguồn; các mục khác vẫn được di chuyển.
          </li>
        </ul>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      key="choose"
      title="Chuyển tệp sang tài khoản khác"
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
            data-autofocus={plan.preferredMode === null ? true : undefined}
          >
            Hủy
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setError(null);
              setStep('confirm-move');
            }}
            disabled={busy}
            data-autofocus={plan.preferredMode === 'move' ? true : undefined}
          >
            Di chuyển
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => submit('copy')}
            disabled={busy}
            data-autofocus={plan.preferredMode === 'copy' ? true : undefined}
          >
            {submitting === 'copy' ? 'Đang gửi…' : 'Sao chép'}
          </button>
        </>
      }
    >
      {summary}
      <ul className="item-preview" aria-label="Các mục sẽ chuyển">
        {plan.items.slice(0, PREVIEW_COUNT).map((item) => (
          <li key={item.id}>
            <span aria-hidden="true">{fileKind(item).icon}</span> <span>{item.name}</span>
          </li>
        ))}
        {plan.items.length > PREVIEW_COUNT && (
          <li className="muted">… và {plan.items.length - PREVIEW_COUNT} mục khác</li>
        )}
      </ul>
      {nativeCount > 0 && (
        <p className="hint small">
          Có {nativeCount} tệp Google (Docs/Sheets/Slides). Loại tệp này chỉ sao chép được bằng chức
          năng sao chép của chính Drive
          {crossAccount ? ' và có thể thất bại khi chuyển giữa hai tài khoản.' : '.'}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
