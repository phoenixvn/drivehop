import { useRef, useState } from 'react';
import type { AccountWithQuota, FileEntry, TransferJob, TransferMode } from '@multicloud/shared';
import { useApi } from '../api/ApiContext.ts';
import { ROOT_LABEL, usePane } from '../hooks/usePane.ts';
import type { PaneState } from '../hooks/usePane.ts';
import { strings } from '../lib/i18n.ts';
import { FilePane } from './FilePane.tsx';
import type { DropFolder } from './FilePane.tsx';
import type { PushToast } from './Toasts.tsx';
import { TransferDialog } from './TransferDialog.tsx';
import type { TransferPlan } from './TransferDialog.tsx';

const S = strings({
  en: {
    destNotReady:
      "The destination pane isn't ready yet. Wait for the destination folder to finish loading, then try again.",
    alreadyThere: 'The items are already in this folder, so there is nothing to transfer.',
    intoItself: "A folder can't be transferred into itself or into one of its subfolders.",
    otherNoAccount: 'No account is selected in the other pane.',
    otherNotReady: "The other pane hasn't finished loading or has an error.",
    sameFolder: 'Both panes show the same folder of the same account.',
    leftPane: 'Left pane',
    rightPane: 'Right pane',
    title: 'File browser',
    intro:
      'Select items, then drag them to the other pane (or drop them on a folder) to copy or move them. Not using a mouse? Select with the Space bar, then use the “Copy to other side” / “Move to other side” buttons.',
    noAccounts: 'No accounts yet. Open the “Overview” page and click “Add Google account”.',
  },
  vi: {
    destNotReady: 'Ngăn đích chưa sẵn sàng. Hãy đợi thư mục đích tải xong rồi thử lại.',
    alreadyThere: 'Các mục đã nằm sẵn trong thư mục này, không có gì để chuyển.',
    intoItself: 'Không thể chuyển một thư mục vào chính nó hoặc vào thư mục con của nó.',
    otherNoAccount: 'Ngăn bên kia chưa chọn tài khoản.',
    otherNotReady: 'Ngăn bên kia chưa tải xong hoặc đang lỗi.',
    sameFolder: 'Hai ngăn đang mở cùng một thư mục của cùng một tài khoản.',
    leftPane: 'Ngăn trái',
    rightPane: 'Ngăn phải',
    title: 'Trình duyệt tệp',
    intro:
      'Chọn các mục rồi kéo sang ngăn bên kia (hoặc thả lên một thư mục) để sao chép hay di chuyển. Không dùng chuột? Chọn bằng phím cách, rồi dùng nút “Sao chép sang bên kia” / “Di chuyển sang bên kia”.',
    noAccounts: 'Chưa có tài khoản nào. Hãy mở trang “Tổng quan” và bấm “Thêm tài khoản Google”.',
  },
});

type Side = 'left' | 'right';

interface DragPayload {
  side: Side;
  items: FileEntry[];
}

interface FileBrowserProps {
  accounts: readonly AccountWithQuota[];
  accountsLoading: boolean;
  /** Changes when a finished transfer touched the account, so panes re-fetch their listing. */
  listingVersion: (accountId: string) => number;
  onTransferCreated: (job: TransferJob) => void;
  pushToast: PushToast;
}

function pathText(pane: PaneState, extra?: string): string {
  const names =
    pane.breadcrumbs.length > 0
      ? pane.breadcrumbs.map((crumb, index) => (index === 0 ? ROOT_LABEL : crumb.name))
      : [ROOT_LABEL];
  if (extra !== undefined) names.push(extra);
  return names.join(' / ');
}

/** Ids that denote the pane's current folder ('root' is an alias of the real root id). */
function currentFolderIds(pane: PaneState): Set<string> {
  const ids = new Set([pane.folderId]);
  const last = pane.breadcrumbs.at(-1);
  if (last) ids.add(last.id);
  return ids;
}

function sameLocation(a: PaneState, b: PaneState): boolean {
  if (a.accountId === null || a.accountId !== b.accountId) return false;
  const idsB = currentFolderIds(b);
  return [...currentFolderIds(a)].some((id) => idsB.has(id));
}

export function FileBrowser({
  accounts,
  accountsLoading,
  listingVersion,
  onTransferCreated,
  pushToast,
}: FileBrowserProps) {
  const api = useApi();
  const left = usePane(api, accounts, listingVersion, 0);
  const right = usePane(api, accounts, listingVersion, 1);
  const dragRef = useRef<DragPayload | null>(null);
  const [plan, setPlan] = useState<(TransferPlan & { sourceSide: Side }) | null>(null);

  const paneOf = (side: Side): PaneState => (side === 'left' ? left : right);
  const otherSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');

  const requestTransfer = (
    sourceSide: Side,
    items: FileEntry[],
    folder: DropFolder | null,
    preferredMode: TransferMode | null,
  ): void => {
    const source = paneOf(sourceSide);
    const dest = paneOf(otherSide(sourceSide));
    if (items.length === 0 || source.accountId === null || dest.accountId === null) return;
    if (dest.loadState !== 'ready') {
      pushToast('error', S.destNotReady);
      return;
    }

    const sameAccount = source.accountId === dest.accountId;
    if (sameAccount) {
      const itemIds = new Set(items.map((item) => item.id));
      // Dropping into the folder the items already live in changes nothing.
      const destIsSourceFolder =
        folder === null ? sameLocation(source, dest) : currentFolderIds(source).has(folder.id);
      if (destIsSourceFolder) {
        pushToast('info', S.alreadyThere);
        return;
      }
      // A folder cannot go into itself or into one of its own subfolders.
      const destChain = [...dest.breadcrumbs.map((crumb) => crumb.id), dest.folderId];
      if (folder) destChain.push(folder.id);
      if (destChain.some((id) => itemIds.has(id))) {
        pushToast('error', S.intoItself);
        return;
      }
    }

    setPlan({
      sourceSide,
      sourceAccountId: source.accountId,
      sourceFolderPath: pathText(source),
      destAccountId: dest.accountId,
      destFolderId: folder?.id ?? dest.folderId,
      destFolderPath: pathText(dest, folder?.name),
      items,
      preferredMode,
    });
  };

  const blockedReason = (side: Side): string | null => {
    const source = paneOf(side);
    const dest = paneOf(otherSide(side));
    if (dest.accountId === null) return S.otherNoAccount;
    if (dest.loadState !== 'ready') return S.otherNotReady;
    if (sameLocation(source, dest)) return S.sameFolder;
    return null;
  };

  const renderPane = (side: Side) => {
    const pane = paneOf(side);
    return (
      <FilePane
        label={side === 'left' ? S.leftPane : S.rightPane}
        pane={pane}
        accounts={accounts}
        transferBlockedReason={blockedReason(side)}
        onTransferSelection={(mode) =>
          requestTransfer(
            side,
            pane.entries.filter((entry) => pane.selectedIds.has(entry.id)),
            null,
            mode,
          )
        }
        onDragStartItems={(items) => {
          dragRef.current = { side, items };
        }}
        onDragEndItems={() => {
          dragRef.current = null;
        }}
        canAcceptDrop={() => dragRef.current !== null && dragRef.current.side !== side}
        onDropItems={(folder) => {
          const payload = dragRef.current;
          dragRef.current = null;
          if (payload && payload.side !== side) {
            requestTransfer(payload.side, payload.items, folder, null);
          }
        }}
      />
    );
  };

  return (
    <section className="browser" aria-labelledby="browser-title">
      <div className="section-head">
        <div>
          <h2 id="browser-title">{S.title}</h2>
          <p className="muted">{S.intro}</p>
        </div>
      </div>

      {accounts.length === 0 && !accountsLoading ? (
        <p className="state">{S.noAccounts}</p>
      ) : (
        <div className="panes">
          {renderPane('left')}
          {renderPane('right')}
        </div>
      )}

      {plan && (
        <TransferDialog
          plan={plan}
          accounts={accounts}
          onClose={() => setPlan(null)}
          onCreated={(job) => {
            paneOf(plan.sourceSide).setSelectedIds(new Set<string>());
            setPlan(null);
            onTransferCreated(job);
          }}
        />
      )}
    </section>
  );
}
