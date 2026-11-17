// Dev-only fake data for `?mock=1`. Nothing in here talks to a server or to Google.
import { ROOT_FOLDER_ID } from '@multicloud/shared';
import type { Account, FileEntry, Quota } from '@multicloud/shared';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface MockAccount {
  account: Account;
  quota: Quota;
}

export function createMockAccounts(): MockAccount[] {
  return [
    {
      account: {
        id: 'acc-1',
        provider: 'google-drive',
        email: 'lan.nguyen.mock@gmail.com',
        displayName: 'Nguyễn Lan (giả lập)',
        status: 'connected',
      },
      quota: { usedBytes: 11.4 * GIB, totalBytes: 15 * GIB, trashBytes: 0.3 * GIB, driveBytes: 8.2 * GIB },
    },
    {
      account: {
        id: 'acc-2',
        provider: 'google-drive',
        email: 'congviec.mock@gmail.com',
        displayName: 'Công việc (giả lập)',
        status: 'connected',
      },
      quota: { usedBytes: 61 * GIB, totalBytes: 100 * GIB },
    },
    {
      account: {
        id: 'acc-3',
        provider: 'google-drive',
        email: 'luutru.anh.mock@gmail.com',
        displayName: 'Lưu trữ ảnh (giả lập)',
        status: 'connected',
      },
      quota: { usedBytes: 14.8 * GIB, totalBytes: 15 * GIB, trashBytes: 9.6 * GIB, driveBytes: 12.1 * GIB, gmailBytes: 1.9 * GIB, photosBytes: 0.8 * GIB },
    },
    {
      account: {
        id: 'acc-4',
        provider: 'google-drive',
        email: 'truonghoc.mock@example.edu.vn',
        displayName: 'Trường học (giả lập)',
        status: 'connected',
      },
      quota: { usedBytes: 230 * GIB, totalBytes: null },
    },
    {
      account: {
        id: 'acc-5',
        provider: 'google-drive',
        email: 'taikhoan.cu.mock@gmail.com',
        displayName: 'Tài khoản cũ (giả lập)',
        status: 'needs_reconnect',
      },
      quota: { usedBytes: 2.1 * GIB, totalBytes: 15 * GIB },
    },
  ];
}

let idCounter = 0;

export function nextMockId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function makeEntry(
  accountId: string,
  parentId: string,
  name: string,
  mimeType: string,
  sizeBytes: number | null,
  ageDays: number,
): FileEntry {
  const isFolder = mimeType === FOLDER_MIME;
  const isGoogleNative = !isFolder && mimeType.startsWith('application/vnd.google-apps.');
  return {
    id: nextMockId('file'),
    accountId,
    name,
    mimeType,
    isFolder,
    sizeBytes: isFolder || isGoogleNative ? null : sizeBytes,
    modifiedTime: daysAgo(ageDays),
    parents: [parentId],
    isGoogleNative,
    capabilities: { canCopy: true, canTrash: true, canDownload: !isGoogleNative && !isFolder },
  };
}

/** Flat store of every fake file, across all accounts. */
export function createMockFiles(accounts: MockAccount[]): FileEntry[] {
  const files: FileEntry[] = [];
  const add = (entry: FileEntry): FileEntry => {
    files.push(entry);
    return entry;
  };

  accounts.forEach(({ account }, index) => {
    const a = account.id;
    const docs = add(makeEntry(a, ROOT_FOLDER_ID, 'Tài liệu', FOLDER_MIME, null, 3));
    const photos = add(makeEntry(a, ROOT_FOLDER_ID, 'Ảnh', FOLDER_MIME, null, 12));
    add(makeEntry(a, ROOT_FOLDER_ID, 'Thư mục trống', FOLDER_MIME, null, 40));
    add(
      makeEntry(a, ROOT_FOLDER_ID, 'Kế hoạch 2026', 'application/vnd.google-apps.document', null, 1),
    );
    add(
      makeEntry(
        a,
        ROOT_FOLDER_ID,
        'Ngân sách gia đình',
        'application/vnd.google-apps.spreadsheet',
        null,
        6,
      ),
    );
    add(makeEntry(a, ROOT_FOLDER_ID, `sao-luu-${index + 1}.zip`, 'application/zip', 1.8 * GIB, 20));
    add(makeEntry(a, ROOT_FOLDER_ID, 'video-du-lich.mp4', 'video/mp4', 742 * MIB, 55));
    add(makeEntry(a, ROOT_FOLDER_ID, 'ghi-chu.txt', 'text/plain', 2_140, 2));
    // A name that would be dangerous if it were ever rendered as HTML.
    add(
      makeEntry(a, ROOT_FOLDER_ID, '<img src=x onerror=alert(1)>.txt', 'text/plain', 512, 9),
    );

    const contracts = add(makeEntry(a, docs.id, 'Hợp đồng', FOLDER_MIME, null, 30));
    add(makeEntry(a, docs.id, 'Báo cáo quý 3.pdf', 'application/pdf', 4.2 * MIB, 14));
    add(
      makeEntry(a, docs.id, 'Trình bày dự án', 'application/vnd.google-apps.presentation', null, 4),
    );
    add(
      makeEntry(
        a,
        docs.id,
        'Danh sách khách hàng.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        380_000,
        8,
      ),
    );
    add(makeEntry(a, contracts.id, 'hop-dong-thue-nha.pdf', 'application/pdf', 1.1 * MIB, 200));
    add(makeEntry(a, contracts.id, 'phu-luc-01.docx', 'application/msword', 96_000, 190));

    // Enough files to need "Tải thêm" (the mock pages at 25 entries).
    for (let i = 1; i <= 60; i += 1) {
      const name = `IMG_${String(i).padStart(4, '0')}.jpg`;
      add(makeEntry(a, photos.id, name, 'image/jpeg', (2 + (i % 7)) * MIB, 60 + i));
    }
    add(makeEntry(a, photos.id, 'Đà Lạt 2025', FOLDER_MIME, null, 70));
  });

  return files;
}
