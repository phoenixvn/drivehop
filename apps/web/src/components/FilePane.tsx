import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { ROOT_FOLDER_ID } from '@multicloud/shared';
import type { AccountWithQuota, FileEntry, TransferMode } from '@multicloud/shared';
import { ROOT_LABEL } from '../hooks/usePane.ts';
import type { PaneState } from '../hooks/usePane.ts';
import { fileKind, formatBytes, formatCount, formatDate } from '../lib/format.ts';
import { strings } from '../lib/i18n.ts';

const S = strings({
  en: {
    noAccounts: 'No accounts yet',
    needsReconnect: ' (needs reconnecting)',
    refreshing: 'Refreshing…',
    refresh: 'Refresh',
    breadcrumbLabel: (label: string) => `Folder path, ${label}`,
    selected: (n: number) => `${formatCount(n)} selected`,
    count: (n: number) => `${formatCount(n)} ${n === 1 ? 'item' : 'items'}`,
    hasMore: ' (more available)',
    copyToOther: 'Copy to other side',
    moveToOther: 'Move to other side',
    addAccountHint: 'Add a Google account on the “Overview” page to browse files.',
    loadingFiles: 'Loading files…',
    folderLoadFailed: "Couldn't load this folder.",
    reconnectHint: 'Open the “Overview” page and click “Reconnect” for',
    retry: 'Retry',
    emptyFolder: 'This folder is empty. You can drag files here from the other pane.',
    filesIn: (path: string) => `Files in ${path}`,
    selectAll: 'Select all',
    name: 'Name',
    size: 'Size',
    modified: 'Modified',
    selectItem: (name: string) => `Select ${name}`,
    openFolder: (name: string) => `Open folder ${name}`,
    nativeTag:
      "Google file (Docs/Sheets/Slides): can only be copied with Drive's own copy, which may fail between two accounts.",
    nativeHint:
      "* Google files (Docs/Sheets/Slides) have no binary content: they can only be copied with Drive's own copy, which may fail between two accounts.",
    loadMoreFailed: "Couldn't load more.",
    loading: 'Loading…',
    loadMore: 'Load more',
  },
  vi: {
    noAccounts: 'Chưa có tài khoản',
    needsReconnect: ' (cần kết nối lại)',
    refreshing: 'Đang làm mới…',
    refresh: 'Làm mới',
    breadcrumbLabel: (label: string) => `Đường dẫn thư mục, ${label}`,
    selected: (n: number) => `Đã chọn ${n} mục`,
    count: (n: number) => `${n} mục`,
    hasMore: ' (còn nữa)',
    copyToOther: 'Sao chép sang bên kia',
    moveToOther: 'Di chuyển sang bên kia',
    addAccountHint: 'Hãy thêm tài khoản Google ở trang “Tổng quan” để duyệt tệp.',
    loadingFiles: 'Đang tải danh sách tệp…',
    folderLoadFailed: 'Không tải được thư mục này.',
    reconnectHint: 'Mở trang “Tổng quan” và bấm “Kết nối lại” cho tài khoản',
    retry: 'Thử lại',
    emptyFolder: 'Thư mục này trống. Bạn có thể kéo tệp từ ngăn bên kia thả vào đây.',
    filesIn: (path: string) => `Tệp trong ${path}`,
    selectAll: 'Chọn tất cả',
    name: 'Tên',
    size: 'Kích thước',
    modified: 'Sửa đổi',
    selectItem: (name: string) => `Chọn ${name}`,
    openFolder: (name: string) => `Mở thư mục ${name}`,
    nativeTag:
      'Tệp Google (Docs/Sheets/Slides): chỉ sao chép được bằng chức năng sao chép của chính Drive và có thể thất bại giữa hai tài khoản.',
    nativeHint:
      '* Tệp Google (Docs/Sheets/Slides) không có nội dung nhị phân: chỉ sao chép được bằng chức năng sao chép của chính Drive và có thể thất bại khi chuyển giữa hai tài khoản.',
    loadMoreFailed: 'Không tải thêm được.',
    loading: 'Đang tải…',
    loadMore: 'Tải thêm',
  },
});

/** Custom drag type: lets drop targets recognise our own drags without reading the data. */
export const DRAG_MIME = 'application/x-multicloud-items';

export interface DropFolder {
  id: string;
  name: string;
}

interface FilePaneProps {
  label: string;
  pane: PaneState;
  accounts: readonly AccountWithQuota[];
  /** Why the "to the other side" buttons are unavailable, or null when they can be used. */
  transferBlockedReason: string | null;
  onTransferSelection: (mode: TransferMode) => void;
  onDragStartItems: (items: FileEntry[]) => void;
  onDragEndItems: () => void;
  /** True when the drag in progress started in the other pane. */
  canAcceptDrop: () => boolean;
  /** `folder` is null when dropped on the pane's current folder. */
  onDropItems: (folder: DropFolder | null) => void;
}

export function FilePane({
  label,
  pane,
  accounts,
  transferBlockedReason,
  onTransferSelection,
  onDragStartItems,
  onDragEndItems,
  canAcceptDrop,
  onDropItems,
}: FilePaneProps) {
  const selectId = useId();
  const hintId = useId();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  // 'pane' = the current folder is the drop target; otherwise the id of a folder row.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const { entries, selectedIds } = pane;
  const selectedEntries = entries.filter((entry) => selectedIds.has(entry.id));
  const allSelected = entries.length > 0 && selectedEntries.length === entries.length;
  const someSelected = selectedEntries.length > 0 && !allSelected;
  const selectedBytes = selectedEntries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const hasNative = entries.some((entry) => entry.isGoogleNative);
  const safeFocusIndex = Math.min(focusIndex, Math.max(0, entries.length - 1));

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  // A new folder starts with a fresh keyboard position and selection anchor.
  useEffect(() => {
    setFocusIndex(0);
    anchorRef.current = null;
  }, [pane.accountId, pane.folderId]);

  const focusRow = (index: number): void => {
    const clamped = Math.max(0, Math.min(entries.length - 1, index));
    setFocusIndex(clamped);
    bodyRef.current?.querySelector<HTMLElement>(`[data-row-index="${clamped}"]`)?.focus();
  };

  const toggle = (entry: FileEntry): void => {
    const next = new Set(selectedIds);
    if (next.has(entry.id)) next.delete(entry.id);
    else next.add(entry.id);
    anchorRef.current = entry.id;
    pane.setSelectedIds(next);
  };

  const selectRange = (toIndex: number, additive: boolean): void => {
    const anchorIndex = entries.findIndex((entry) => entry.id === anchorRef.current);
    const from = anchorIndex < 0 ? toIndex : anchorIndex;
    const [start, end] = from <= toIndex ? [from, toIndex] : [toIndex, from];
    const next = additive ? new Set(selectedIds) : new Set<string>();
    for (const entry of entries.slice(start, end + 1)) next.add(entry.id);
    pane.setSelectedIds(next);
  };

  const handleRowClick = (event: MouseEvent, entry: FileEntry, index: number): void => {
    setFocusIndex(index);
    if (event.shiftKey) {
      selectRange(index, event.ctrlKey || event.metaKey);
    } else if (event.ctrlKey || event.metaKey) {
      toggle(entry);
    } else {
      anchorRef.current = entry.id;
      pane.setSelectedIds(new Set([entry.id]));
    }
  };

  const handleRowKeyDown = (event: KeyboardEvent, entry: FileEntry, index: number): void => {
    // Keys pressed inside the checkbox / name button are handled by those controls.
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (event.shiftKey) selectRange(Math.min(entries.length - 1, index + 1), false);
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (event.shiftKey) selectRange(Math.max(0, index - 1), false);
        focusRow(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(entries.length - 1);
        break;
      case ' ':
        event.preventDefault();
        toggle(entry);
        break;
      case 'Enter':
        if (entry.isFolder) {
          event.preventDefault();
          pane.openFolder(entry.id);
        }
        break;
      case 'a':
      case 'A':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          pane.setSelectedIds(new Set(entries.map((item) => item.id)));
        }
        break;
      case 'Escape':
        if (selectedIds.size > 0) pane.setSelectedIds(new Set<string>());
        break;
      default:
    }
  };

  const handleDragStart = (event: DragEvent, entry: FileEntry): void => {
    // Dragging an unselected row drags just that row (and makes it the selection).
    const items = selectedIds.has(entry.id) ? selectedEntries : [entry];
    if (!selectedIds.has(entry.id)) {
      anchorRef.current = entry.id;
      pane.setSelectedIds(new Set([entry.id]));
    }
    event.dataTransfer.setData(DRAG_MIME, String(items.length));
    event.dataTransfer.setData('text/plain', items.map((item) => item.name).join('\n'));
    event.dataTransfer.effectAllowed = 'copyMove';
    onDragStartItems(items);
  };

  const acceptsDrag = (event: DragEvent): boolean =>
    event.dataTransfer.types.includes(DRAG_MIME) && canAcceptDrop();

  const handlePaneDragOver = (event: DragEvent): void => {
    if (!acceptsDrag(event) || pane.loadState !== 'ready') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropTarget('pane');
  };

  const handlePaneDrop = (event: DragEvent): void => {
    if (!acceptsDrag(event) || pane.loadState !== 'ready') return;
    event.preventDefault();
    setDropTarget(null);
    onDropItems(null);
  };

  const handleRowDragOver = (event: DragEvent, entry: FileEntry): void => {
    if (!entry.isFolder || !acceptsDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropTarget(entry.id);
  };

  const handleRowDrop = (event: DragEvent, entry: FileEntry): void => {
    if (!entry.isFolder || !acceptsDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    onDropItems({ id: entry.id, name: entry.name });
  };

  const account = accounts.find((candidate) => candidate.id === pane.accountId);
  const crumbs =
    pane.breadcrumbs.length > 0 ? pane.breadcrumbs : [{ id: ROOT_FOLDER_ID, name: ROOT_LABEL }];
  const transferDisabled = selectedEntries.length === 0 || transferBlockedReason !== null;

  return (
    <section
      className={`pane${dropTarget === 'pane' ? ' pane--drop' : ''}`}
      aria-label={label}
      onDragOver={handlePaneDragOver}
      onDrop={handlePaneDrop}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropTarget(null);
      }}
    >
      <header className="pane__header">
        <div className="pane__account">
          <label htmlFor={selectId} className="pane__label">
            {label}
          </label>
          <select
            id={selectId}
            className="select"
            value={pane.accountId ?? ''}
            onChange={(event) => pane.setAccount(event.target.value)}
            disabled={accounts.length === 0}
          >
            {accounts.length === 0 && <option value="">{S.noAccounts}</option>}
            {accounts.map((option) => (
              <option key={option.id} value={option.id}>
                {option.email}
                {option.status === 'needs_reconnect' ? S.needsReconnect : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button--small"
            onClick={pane.refresh}
            disabled={pane.accountId === null || pane.loadState === 'loading' || pane.refreshing}
          >
            {pane.refreshing ? S.refreshing : S.refresh}
          </button>
        </div>

        <nav aria-label={S.breadcrumbLabel(label)}>
          <ol className="crumbs">
            {crumbs.map((crumb, index) => {
              const isLast = index === crumbs.length - 1;
              const name = index === 0 ? ROOT_LABEL : crumb.name;
              return (
                <li key={`${crumb.id}-${index}`}>
                  {isLast ? (
                    <span aria-current="page" className="crumbs__current">
                      {name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => pane.openFolder(index === 0 ? ROOT_FOLDER_ID : crumb.id)}
                    >
                      {name}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="pane__toolbar">
          <span className="muted small" role="status">
            {selectedEntries.length > 0
              ? `${S.selected(selectedEntries.length)}${selectedBytes > 0 ? ` (${formatBytes(selectedBytes)})` : ''}`
              : `${S.count(entries.length)}${pane.hasMore ? S.hasMore : ''}`}
          </span>
          <div className="pane__toolbar-buttons">
            <button
              type="button"
              className="button button--small"
              disabled={transferDisabled}
              title={transferBlockedReason ?? undefined}
              onClick={() => onTransferSelection('copy')}
            >
              {S.copyToOther}
            </button>
            <button
              type="button"
              className="button button--small"
              disabled={transferDisabled}
              title={transferBlockedReason ?? undefined}
              onClick={() => onTransferSelection('move')}
            >
              {S.moveToOther}
            </button>
          </div>
        </div>
      </header>

      <div className="pane__body">
        {pane.accountId === null && (
          <p className="state">{S.addAccountHint}</p>
        )}
        {pane.loadState === 'loading' && (
          <p className="state" role="status">
            {S.loadingFiles}
          </p>
        )}
        {pane.loadState === 'error' && (
          <div className="state state--error" role="alert">
            <p>{S.folderLoadFailed} {pane.error}</p>
            {pane.needsReconnect && (
              <p>
                {S.reconnectHint}{' '}
                <strong>{account?.email}</strong>.
              </p>
            )}
            <button type="button" className="button" onClick={pane.refresh}>
              {S.retry}
            </button>
          </div>
        )}
        {pane.loadState === 'ready' && entries.length === 0 && (
          <p className="state">{S.emptyFolder}</p>
        )}

        {pane.loadState === 'ready' && entries.length > 0 && (
          <>
            <table
              className="files"
              role="grid"
              aria-multiselectable="true"
              aria-label={S.filesIn(
                crumbs.map((crumb, index) => (index === 0 ? ROOT_LABEL : crumb.name)).join(' / '),
              )}
              aria-describedby={hasNative ? hintId : undefined}
            >
              <thead>
                <tr>
                  <th scope="col" className="files__check">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      aria-label={S.selectAll}
                      checked={allSelected}
                      onChange={() =>
                        pane.setSelectedIds(
                          allSelected ? new Set<string>() : new Set(entries.map((entry) => entry.id)),
                        )
                      }
                    />
                  </th>
                  <th scope="col">{S.name}</th>
                  <th scope="col" className="files__size">
                    {S.size}
                  </th>
                  <th scope="col" className="files__date">
                    {S.modified}
                  </th>
                </tr>
              </thead>
              <tbody ref={bodyRef}>
                {entries.map((entry, index) => {
                  const kind = fileKind(entry);
                  const selected = selectedIds.has(entry.id);
                  const classes = [
                    'files__row',
                    selected ? 'files__row--selected' : '',
                    dropTarget === entry.id ? 'files__row--drop' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <tr
                      key={entry.id}
                      className={classes}
                      data-row-index={index}
                      aria-selected={selected}
                      tabIndex={index === safeFocusIndex ? 0 : -1}
                      draggable
                      onClick={(event) => handleRowClick(event, entry, index)}
                      onDoubleClick={() => {
                        if (entry.isFolder) pane.openFolder(entry.id);
                      }}
                      onKeyDown={(event) => handleRowKeyDown(event, entry, index)}
                      onFocus={() => setFocusIndex(index)}
                      onDragStart={(event) => handleDragStart(event, entry)}
                      onDragEnd={() => {
                        setDropTarget(null);
                        onDragEndItems();
                      }}
                      onDragOver={(event) => handleRowDragOver(event, entry)}
                      onDrop={(event) => handleRowDrop(event, entry)}
                    >
                      <td className="files__check">
                        <input
                          type="checkbox"
                          tabIndex={-1}
                          aria-label={S.selectItem(entry.name)}
                          checked={selected}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggle(entry)}
                        />
                      </td>
                      <td>
                        <div className="files__name">
                        <span className="files__icon" aria-hidden="true">
                          {kind.icon}
                        </span>
                        <span className="files__name-text">
                          {entry.isFolder ? (
                            <button
                              type="button"
                              className="link-button files__open"
                              tabIndex={-1}
                              title={entry.name}
                              aria-label={S.openFolder(entry.name)}
                              onClick={(event) => {
                                event.stopPropagation();
                                pane.openFolder(entry.id);
                              }}
                            >
                              {entry.name}
                            </button>
                          ) : (
                            <span title={entry.name}>{entry.name}</span>
                          )}
                          <span className="visually-hidden">, {kind.label}</span>
                          {entry.isGoogleNative && (
                            <span
                              className="tag"
                              title={S.nativeTag}
                            >
                              {kind.label}*
                            </span>
                          )}
                        </span>
                        </div>
                      </td>
                      <td className="files__size">
                        {entry.sizeBytes === null ? '—' : formatBytes(entry.sizeBytes)}
                      </td>
                      <td className="files__date">{formatDate(entry.modifiedTime)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {hasNative && (
              <p id={hintId} className="hint small">
                {S.nativeHint}
              </p>
            )}

            {pane.loadMoreError && (
              <p className="error-text" role="alert">
                {S.loadMoreFailed} {pane.loadMoreError}
              </p>
            )}
            {pane.hasMore && (
              <div className="pane__more">
                <button
                  type="button"
                  className="button"
                  onClick={pane.loadMore}
                  disabled={pane.loadingMore}
                >
                  {pane.loadingMore ? S.loading : S.loadMore}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
