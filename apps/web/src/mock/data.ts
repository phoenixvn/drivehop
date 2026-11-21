// Dev-only fake data for `?mock=1`. Nothing in here talks to a server or to Google.
import { ROOT_FOLDER_ID } from '@multicloud/shared';
import type { Account, FileEntry, Quota } from '@multicloud/shared';
import { strings } from '../lib/i18n.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Demo names follow the UI language (the English ones show up in the public demo GIF).
// Everything stays obviously fake.
const M = strings({
  en: {
    accounts: [
      { email: 'alex.personal@example.com', name: 'Alex (personal)' },
      { email: 'alex.work@example.com', name: 'Work' },
      { email: 'photo.archive@example.com', name: 'Photo archive' },
      { email: 'alex@school.example.edu', name: 'School' },
      { email: 'old.account@example.com', name: 'Old account' },
    ],
    documents: 'Documents',
    photos: 'Photos',
    emptyFolder: 'Empty folder',
    plan: 'Plans 2026',
    budget: 'Family budget',
    backup: (n: number) => `backup-${n}.zip`,
    video: 'Vacation.mp4',
    notes: 'notes.txt',
    contracts: 'Taxes',
    report: 'Q3 report.pdf',
    pitch: 'Project pitch',
    customers: 'Customer list.xlsx',
    lease: 'tax-return-2025.pdf',
    appendix: 'receipts-01.docx',
    trip: 'Photos 2024',
  },
  vi: {
    accounts: [
      { email: 'lan.nguyen.mock@gmail.com', name: 'Nguyễn Lan (giả lập)' },
      { email: 'congviec.mock@gmail.com', name: 'Công việc (giả lập)' },
      { email: 'luutru.anh.mock@gmail.com', name: 'Lưu trữ ảnh (giả lập)' },
      { email: 'truonghoc.mock@example.edu.vn', name: 'Trường học (giả lập)' },
      { email: 'taikhoan.cu.mock@gmail.com', name: 'Tài khoản cũ (giả lập)' },
    ],
    documents: 'Tài liệu',
    photos: 'Ảnh',
    emptyFolder: 'Thư mục trống',
    plan: 'Kế hoạch 2026',
    budget: 'Ngân sách gia đình',
    backup: (n: number) => `sao-luu-${n}.zip`,
    video: 'video-du-lich.mp4',
    notes: 'ghi-chu.txt',
    contracts: 'Hợp đồng',
    report: 'Báo cáo quý 3.pdf',
    pitch: 'Trình bày dự án',
    customers: 'Danh sách khách hàng.xlsx',
    lease: 'hop-dong-thue-nha.pdf',
    appendix: 'phu-luc-01.docx',
    trip: 'Đà Lạt 2025',
  },
});

function mockIdentity(index: number): { email: string; displayName: string } {
  const entry = M.accounts[index];
  if (!entry) throw new Error(`No mock account #${index}`);
  return { email: entry.email, displayName: entry.name };
}

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
        ...mockIdentity(0),
        status: 'connected',
      },
      quota: { usedBytes: 11.4 * GIB, totalBytes: 15 * GIB, trashBytes: 0.3 * GIB, driveBytes: 8.2 * GIB },
    },
    {
      account: {
        id: 'acc-2',
        provider: 'google-drive',
        ...mockIdentity(1),
        status: 'connected',
      },
      quota: { usedBytes: 61 * GIB, totalBytes: 100 * GIB },
    },
    {
      account: {
        id: 'acc-3',
        provider: 'google-drive',
        ...mockIdentity(2),
        status: 'connected',
      },
      quota: { usedBytes: 14.8 * GIB, totalBytes: 15 * GIB, trashBytes: 9.6 * GIB, driveBytes: 12.1 * GIB, gmailBytes: 1.9 * GIB, photosBytes: 0.8 * GIB },
    },
    {
      account: {
        id: 'acc-4',
        provider: 'google-drive',
        ...mockIdentity(3),
        status: 'connected',
      },
      quota: { usedBytes: 230 * GIB, totalBytes: null },
    },
    {
      account: {
        id: 'acc-5',
        provider: 'google-drive',
        ...mockIdentity(4),
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
    const docs = add(makeEntry(a, ROOT_FOLDER_ID, M.documents, FOLDER_MIME, null, 3));
    const photos = add(makeEntry(a, ROOT_FOLDER_ID, M.photos, FOLDER_MIME, null, 12));
    add(makeEntry(a, ROOT_FOLDER_ID, M.emptyFolder, FOLDER_MIME, null, 40));
    add(makeEntry(a, ROOT_FOLDER_ID, M.plan, 'application/vnd.google-apps.document', null, 1));
    add(
      makeEntry(
        a,
        ROOT_FOLDER_ID,
        M.budget,
        'application/vnd.google-apps.spreadsheet',
        null,
        6,
      ),
    );
    add(makeEntry(a, ROOT_FOLDER_ID, M.backup(index + 1), 'application/zip', 1.8 * GIB, 20));
    add(makeEntry(a, ROOT_FOLDER_ID, M.video, 'video/mp4', 742 * MIB, 55));
    add(makeEntry(a, ROOT_FOLDER_ID, M.notes, 'text/plain', 2_140, 2));
    // A name that would be dangerous if it were ever rendered as HTML. Left out with `&demo=1`,
    // which the README demo recording uses.
    if (new URLSearchParams(window.location.search).get('demo') !== '1') {
      add(
        makeEntry(a, ROOT_FOLDER_ID, '<img src=x onerror=alert(1)>.txt', 'text/plain', 512, 9),
      );
    }

    const contracts = add(makeEntry(a, docs.id, M.contracts, FOLDER_MIME, null, 30));
    add(makeEntry(a, docs.id, M.report, 'application/pdf', 4.2 * MIB, 14));
    add(makeEntry(a, docs.id, M.pitch, 'application/vnd.google-apps.presentation', null, 4));
    add(
      makeEntry(
        a,
        docs.id,
        M.customers,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        380_000,
        8,
      ),
    );
    add(makeEntry(a, contracts.id, M.lease, 'application/pdf', 1.1 * MIB, 200));
    add(makeEntry(a, contracts.id, M.appendix, 'application/msword', 96_000, 190));

    // Enough files to need "Load more" (the mock pages at 25 entries).
    for (let i = 1; i <= 60; i += 1) {
      const name = `IMG_${String(i).padStart(4, '0')}.jpg`;
      add(makeEntry(a, photos.id, name, 'image/jpeg', (2 + (i % 7)) * MIB, 60 + i));
    }
    add(makeEntry(a, photos.id, M.trip, FOLDER_MIME, null, 70));
  });

  return files;
}
