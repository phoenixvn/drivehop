import { useState } from 'react';
import type {
  AccountWithQuota,
  CreateTransferRequest,
  FileEntry,
  TransferJob,
  TransferMode,
} from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import { apiErrorText, fileKind, formatBytes, formatCount } from '../lib/format.ts';
import { strings } from '../lib/i18n.ts';
import { Dialog } from './Dialog.tsx';

const items = (n: number): string => `${formatCount(n)} ${n === 1 ? 'item' : 'items'}`;

const S = strings({
  en: {
    source: 'Source',
    destination: 'Destination',
    itemCount: 'Items',
    items,
    includingFolders: (n: number) => ` (including ${formatCount(n)} ${n === 1 ? 'folder' : 'folders'})`,
    totalSize: 'Total size',
    unknownSizes: (n: number) =>
      ` (not counting ${items(n)} of unknown size: folders or Google files)`,
    confirmMoveTitle: 'Confirm move',
    back: 'Back',
    sending: 'Sending…',
    confirmMoveN: (n: number) => `Move ${items(n)}`,
    moveIntro: (n: number, from: string, to: string) => (
      <>
        You're about to <strong>move {items(n)}</strong> from <strong>{from}</strong> to{' '}
        <strong>{to}</strong>.
      </>
    ),
    moveStep1: 'First, every item is copied to the destination and checked (size / MD5).',
    moveStep2: (
      <>
        Each item you selected is handled on its own: a file or folder goes to the{' '}
        <strong>Google Drive trash</strong> only once <strong>all</strong> of its content has been
        copied and verified, and only after every copy in the run has finished.
      </>
    ),
    moveStep3: (
      <>
        DriveHop <strong>never deletes originals forever</strong>: you can restore them from the
        Drive trash (note that Google empties the trash after 30 days).
      </>
    ),
    moveStep4:
      "Any item with an error (including a folder holding a file that couldn't be copied) stays in the source account; the other items are still moved.",
    chooseTitle: 'Transfer to another account',
    cancel: 'Cancel',
    move: 'Move',
    copy: 'Copy',
    previewLabel: 'Items to transfer',
    andMore: (n: number) => `… and ${formatCount(n)} more`,
    nativeNote: (n: number, crossAccount: boolean) =>
      `${n === 1 ? 'There is 1 Google file' : `There are ${formatCount(n)} Google files`} (Docs/Sheets/Slides). These can only be copied with Drive's own copy${crossAccount ? ', which may fail between two accounts.' : '.'}`,
  },
  vi: {
    source: 'Nguồn',
    destination: 'Đích',
    itemCount: 'Số mục',
    items: (n: number) => `${n} mục`,
    includingFolders: (n: number) => ` (gồm ${n} thư mục)`,
    totalSize: 'Tổng dung lượng',
    unknownSizes: (n: number) =>
      ` (chưa tính ${n} mục không rõ kích thước: thư mục hoặc tệp Google)`,
    confirmMoveTitle: 'Xác nhận di chuyển',
    back: 'Quay lại',
    sending: 'Đang gửi…',
    confirmMoveN: (n: number) => `Xác nhận di chuyển ${n} mục`,
    moveIntro: (n: number, from: string, to: string) => (
      <>
        Bạn sắp <strong>di chuyển {n} mục</strong> từ <strong>{from}</strong> sang{' '}
        <strong>{to}</strong>.
      </>
    ),
    moveStep1: 'Trước tiên, mọi mục được sao chép sang đích và kiểm tra lại (kích thước / mã MD5).',
    moveStep2: (
      <>
        Mỗi mục bạn chọn được xét riêng: một tệp hay thư mục chỉ được chuyển vào{' '}
        <strong>Thùng rác của Google Drive</strong> khi <strong>toàn bộ</strong> nội dung của nó đã
        được sao chép và kiểm tra thành công, và chỉ sau khi mọi bản sao của lượt chạy đã xong.
      </>
    ),
    moveStep3: (
      <>
        DriveHop <strong>không bao giờ xóa vĩnh viễn</strong> bản gốc: bạn có thể khôi phục chúng
        từ Thùng rác của Drive (lưu ý Google tự dọn Thùng rác sau 30 ngày).
      </>
    ),
    moveStep4:
      'Mục nào có lỗi (kể cả thư mục chứa một tệp không sao chép được) được giữ nguyên ở tài khoản nguồn; các mục khác vẫn được di chuyển.',
    chooseTitle: 'Chuyển tệp sang tài khoản khác',
    cancel: 'Hủy',
    move: 'Di chuyển',
    copy: 'Sao chép',
    previewLabel: 'Các mục sẽ chuyển',
    andMore: (n: number) => `… và ${n} mục khác`,
    nativeNote: (n: number, crossAccount: boolean) =>
      `Có ${n} tệp Google (Docs/Sheets/Slides). Loại tệp này chỉ sao chép được bằng chức năng sao chép của chính Drive${crossAccount ? ' và có thể thất bại khi chuyển giữa hai tài khoản.' : '.'}`,
  },
});

export interface TransferPlan {
  sourceAccountId: string;
  sourceFolderPath: string;
  destAccountId: string;
  destFolderId: string;
  destFolderPath: string;
  items: FileEntry[];
  /** Which button gets the initial focus (the "to the other side" buttons pre-select a mode). */
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
        <dt>{S.source}</dt>
        <dd>
          <span className="summary__account">{emailOf(plan.sourceAccountId)}</span>
          <span className="summary__path">{plan.sourceFolderPath}</span>
        </dd>
      </div>
      <div>
        <dt>{S.destination}</dt>
        <dd>
          <span className="summary__account">{emailOf(plan.destAccountId)}</span>
          <span className="summary__path">{plan.destFolderPath}</span>
        </dd>
      </div>
      <div>
        <dt>{S.itemCount}</dt>
        <dd>
          {S.items(plan.items.length)}
          {folderCount > 0 ? S.includingFolders(folderCount) : ''}
        </dd>
      </div>
      <div>
        <dt>{S.totalSize}</dt>
        <dd>
          {formatBytes(knownBytes)}
          {unknownCount > 0 ? S.unknownSizes(unknownCount) : ''}
        </dd>
      </div>
    </dl>
  );

  if (step === 'confirm-move') {
    return (
      <Dialog
        key="confirm-move"
        title={S.confirmMoveTitle}
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
              {S.back}
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => submit('move')}
              disabled={busy}
            >
              {busy ? S.sending : S.confirmMoveN(plan.items.length)}
            </button>
          </>
        }
      >
        <p>
          {S.moveIntro(plan.items.length, emailOf(plan.sourceAccountId), emailOf(plan.destAccountId))}
        </p>
        <ul className="plain-list">
          <li>{S.moveStep1}</li>
          <li>{S.moveStep2}</li>
          <li>{S.moveStep3}</li>
          <li>{S.moveStep4}</li>
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
      title={S.chooseTitle}
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
            {S.cancel}
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
            {S.move}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => submit('copy')}
            disabled={busy}
            data-autofocus={plan.preferredMode === 'copy' ? true : undefined}
          >
            {submitting === 'copy' ? S.sending : S.copy}
          </button>
        </>
      }
    >
      {summary}
      <ul className="item-preview" aria-label={S.previewLabel}>
        {plan.items.slice(0, PREVIEW_COUNT).map((item) => (
          <li key={item.id}>
            <span aria-hidden="true">{fileKind(item).icon}</span> <span>{item.name}</span>
          </li>
        ))}
        {plan.items.length > PREVIEW_COUNT && (
          <li className="muted">{S.andMore(plan.items.length - PREVIEW_COUNT)}</li>
        )}
      </ul>
      {nativeCount > 0 && (
        <p className="hint small">
          {S.nativeNote(nativeCount, crossAccount)}
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
