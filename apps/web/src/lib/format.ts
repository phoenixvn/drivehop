import {
  API_ERROR_CODES,
  AUTH_ERROR_CODES,
  isTerminalJobStatus,
  splitCodedMessage,
} from '@multicloud/shared';
import type {
  AccountStatus,
  ApiErrorCode,
  AuthErrorCode,
  FileEntry,
  ItemErrorCode,
  ItemWarningCode,
  JobErrorCode,
  TransferItemStatus,
  TransferJob,
  TransferJobStatus,
  TransferMode,
} from '@multicloud/shared';
import { ApiRequestError, CLIENT_ERROR_CODES } from '../api/client.ts';
import { locale, strings } from './i18n.ts';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

/** Binary units (1 GB = 1024^3 bytes), matching how Google Drive reports storage. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${numberFormat.format(value)} ${UNITS[unit] ?? 'B'}`;
}

/** Locale-aware number (1,234 in English, 1.234 in Vietnamese). */
export function formatCount(value: number): string {
  return numberFormat.format(value);
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = strings({
  en: { connected: 'Connected', needs_reconnect: 'Needs reconnecting' },
  vi: { connected: 'Đã kết nối', needs_reconnect: 'Cần kết nối lại' },
});

export const JOB_STATUS_LABELS: Record<TransferJobStatus, string> = strings({
  en: {
    queued: 'Queued',
    running: 'Running',
    verifying: 'Verifying',
    completed: 'Completed',
    completed_with_errors: 'Completed with errors',
    failed: 'Failed',
    canceled: 'Canceled',
  },
  vi: {
    queued: 'Đang chờ',
    running: 'Đang chạy',
    verifying: 'Đang kiểm tra',
    completed: 'Hoàn tất',
    completed_with_errors: 'Hoàn tất, có lỗi',
    failed: 'Thất bại',
    canceled: 'Đã hủy',
  },
});

export const ITEM_STATUS_LABELS: Record<TransferItemStatus, string> = strings({
  en: {
    pending: 'Waiting',
    running: 'Transferring',
    done: 'Done',
    failed: 'Error',
    skipped: 'Skipped',
    canceled: 'Canceled',
  },
  vi: {
    pending: 'Đang chờ',
    running: 'Đang chuyển',
    done: 'Xong',
    failed: 'Lỗi',
    skipped: 'Bỏ qua',
    canceled: 'Đã hủy',
  },
});

/**
 * "Retry" is offered for a finished job with failed OR canceled items (the server's retry re-runs
 * both). Totals carry no canceled count, but in a finished job every item that is neither done nor
 * failed was canceled: the engine never marks items skipped.
 */
export function canRetryJob(job: Pick<TransferJob, 'status' | 'totals'>): boolean {
  if (!isTerminalJobStatus(job.status) || job.status === 'completed') return false;
  return job.totals.failed > 0 || job.totals.done < job.totals.items;
}

/** Shown on a queued job: on Cloudflare a queued job may wait for the background runner (alarm). */
export const QUEUED_JOB_NOTE = strings({
  en: 'The job is queued and waiting for the background runner to pick it up…',
  vi: 'Tác vụ đã vào hàng đợi, đang chờ tiến trình chạy nền bắt đầu xử lý…',
});

export const MODE_LABELS: Record<TransferMode, string> = strings({
  en: { copy: 'Copy', move: 'Move' },
  vi: { copy: 'Sao chép', move: 'Di chuyển' },
});

// The Record<...Code, string> types make the compiler demand a text for every code of the shared
// contract, so a code added on the server cannot silently fall back to a raw string here.
const ITEM_ERROR_TEXT: Record<ItemErrorCode, string> = strings({
  en: {
    google_native_not_streamable:
      "Google Docs/Sheets/Slides files have no binary content, so they can't be downloaded and re-uploaded; they can only be copied with Drive's own copy, which may fail between accounts.",
    shortcut_target_unavailable:
      "This is a shortcut to a file the destination account can't open, so it couldn't be recreated there. Shortcuts take no space; the original was left as is.",
    file_too_large: 'The file is larger than the maximum that can be copied (750 GB).',
    stream_file_too_large:
      'The file is too large to stream in one run on Cloudflare. Use a Google server-side copy (between accounts that can view the file), or split or move this file by hand.',
    verification_failed:
      "The copy didn't match the original when checked (size, MD5 or number of items in the folder). The original was kept.",
    parent_failed:
      "The parent folder couldn't be created in the destination, so this item wasn't transferred.",
    interrupted: 'The transfer was interrupted (the server stopped or lost its connection). Please retry.',
    canceled: 'Canceled.',
    rate_limit:
      'Google is rate-limiting requests, or the account hit its 750 GB/day limit. Please retry later.',
    auth: 'The Google session expired. Reconnect the account, then retry.',
    not_found: 'File or folder not found (it may have been deleted or moved).',
    forbidden: "The account isn't allowed to do this with the file.",
    server: 'Google Drive returned a server error. Please retry later.',
    unknown: 'Unknown error.',
  },
  vi: {
    google_native_not_streamable:
      'Tệp Google Docs/Sheets/Slides không có nội dung nhị phân nên không thể tải xuống rồi tải lên; chỉ sao chép được bằng chức năng sao chép của Drive và có thể thất bại giữa hai tài khoản.',
    shortcut_target_unavailable:
      'Đây là lối tắt (shortcut) trỏ tới một tệp mà tài khoản đích không mở được, nên không tạo lại được lối tắt ở đích. Lối tắt không chiếm dung lượng; bản gốc của nó được giữ nguyên.',
    file_too_large: 'Tệp vượt quá kích thước tối đa có thể sao chép (750 GB).',
    stream_file_too_large:
      'Tệp quá lớn để chuyển qua đường truyền trực tiếp trong một lượt chạy trên Cloudflare. Hãy dùng sao chép phía máy chủ Google (giữa các tài khoản có quyền xem tệp), hoặc chia nhỏ hay di chuyển tệp này thủ công.',
    verification_failed:
      'Bản sao không khớp với bản gốc khi kiểm tra (kích thước, mã MD5 hoặc số mục trong thư mục). Bản gốc được giữ nguyên.',
    parent_failed: 'Không tạo được thư mục cha ở tài khoản đích nên mục này chưa được chuyển.',
    interrupted: 'Quá trình chuyển bị gián đoạn (máy chủ dừng hoặc mất kết nối). Hãy thử lại.',
    canceled: 'Đã hủy.',
    rate_limit:
      'Google đang giới hạn tần suất hoặc tài khoản đã chạm hạn mức 750 GB/ngày. Hãy thử lại sau.',
    auth: 'Phiên đăng nhập Google đã hết hạn. Hãy kết nối lại tài khoản rồi thử lại.',
    not_found: 'Không tìm thấy tệp hoặc thư mục (có thể đã bị xóa hay di chuyển).',
    forbidden: 'Tài khoản không có quyền thực hiện thao tác này với tệp.',
    server: 'Google Drive đang gặp lỗi máy chủ. Hãy thử lại sau.',
    unknown: 'Lỗi không xác định.',
  },
});

const ITEM_WARNING_TEXT: Record<ItemWarningCode, string> = strings({
  en: {
    unshare_failed:
      "Copied, but the temporary view access given to the destination account on the original couldn't be removed. Open the original's \"Share\" settings in Google Drive and remove it.",
    trash_failed:
      "Copied, but the original couldn't be moved to the trash. It is still in the source account.",
    purge_skipped:
      'The original in the trash was NOT deleted forever (the copy in the destination is gone, or you restored the original).',
    purge_failed:
      "The original in the trash couldn't be deleted forever yet. Try deleting forever again later.",
  },
  vi: {
    unshare_failed:
      'Đã sao chép xong nhưng chưa gỡ được quyền xem tạm thời đã cấp cho tài khoản đích trên tệp gốc. Hãy mở mục “Chia sẻ” của tệp gốc trong Google Drive và gỡ quyền đó.',
    trash_failed:
      'Đã sao chép xong nhưng không chuyển được bản gốc vào thùng rác. Bản gốc vẫn còn ở tài khoản nguồn.',
    purge_skipped:
      'Bản gốc trong thùng rác KHÔNG bị xóa vĩnh viễn (bản sao ở đích không còn, hoặc bạn đã khôi phục bản gốc).',
    purge_failed: 'Chưa xóa vĩnh viễn được bản gốc trong thùng rác. Hãy bấm xóa vĩnh viễn lại sau.',
  },
});

const JOB_ERROR_TEXT: Record<JobErrorCode, string> = {
  ...ITEM_ERROR_TEXT,
  ...strings({
    en: {
      move_not_verified:
        "Some items couldn't be fully copied and verified, so their originals were kept; the finished items went to the source account's trash.",
      move_not_confirmed: "The move wasn't confirmed, so no original was moved to the trash.",
      trash_failed:
        "Copied and verified, but some originals couldn't be moved to the trash; those originals are still in the source account.",
    },
    vi: {
      move_not_verified:
        'Một số mục chưa sao chép và kiểm tra được trọn vẹn nên bản gốc của chúng được giữ nguyên; các mục đã xong đã vào thùng rác của tài khoản nguồn.',
      move_not_confirmed:
        'Thao tác di chuyển chưa được xác nhận nên không có bản gốc nào bị chuyển vào thùng rác.',
      trash_failed:
        'Đã sao chép và kiểm tra xong nhưng một số bản gốc không chuyển được vào thùng rác; các bản gốc đó vẫn còn ở tài khoản nguồn.',
    },
  }),
};

export interface FriendlyError {
  /** Text in the UI language, or the raw string when the code is not known. */
  text: string;
  /** Raw detail after "code: ", shown in small print when present. */
  detail?: string;
}

/** `code` or `code: detail` -> readable text. Unknown codes fall back to the raw string. */
function friendly(raw: string | undefined, texts: Readonly<Record<string, string>>): FriendlyError | null {
  if (!raw) return null;
  const { code, detail } = splitCodedMessage(raw);
  const text = Object.hasOwn(texts, code) ? texts[code] : undefined;
  if (!text) return { text: raw };
  return detail ? { text, detail } : { text };
}

/** `TransferItem.error`. */
export function friendlyItemError(raw: string | undefined): FriendlyError | null {
  return friendly(raw, ITEM_ERROR_TEXT);
}

/** `TransferItem.warning`. */
export function friendlyItemWarning(raw: string | undefined): FriendlyError | null {
  return friendly(raw, ITEM_WARNING_TEXT);
}

/** `TransferJob.error`. */
export function friendlyJobError(raw: string | undefined): FriendlyError | null {
  return friendly(raw, JOB_ERROR_TEXT);
}

type KnownApiErrorCode = ApiErrorCode | (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];

const API_ERROR_TEXT: Record<KnownApiErrorCode, string> = strings({
  en: {
    [CLIENT_ERROR_CODES.network]: "Can't reach the DriveHop server.",
    [CLIENT_ERROR_CODES.badResponse]: 'The DriveHop server sent an invalid response.',
    [CLIENT_ERROR_CODES.sessionExpired]:
      "Your session expired or you don't have access. Reload the page to sign in again.",
    [API_ERROR_CODES.notConfigured]: "Google OAuth isn't set up on the server yet.",
    [API_ERROR_CODES.notFound]: 'The requested data was not found.',
    [API_ERROR_CODES.badRequest]: 'Invalid request.',
    [API_ERROR_CODES.moveNotConfirmed]: "The move wasn't confirmed.",
    [API_ERROR_CODES.purgeNotConfirmed]: "The permanent delete wasn't confirmed.",
    [API_ERROR_CODES.needsReconnect]: 'This account needs to be reconnected to Google.',
    [API_ERROR_CODES.rateLimited]: 'Google is rate-limiting requests. Try again in a few minutes.',
    [API_ERROR_CODES.providerError]: 'Google Drive returned an error.',
    [API_ERROR_CODES.internal]: 'The DriveHop server hit an internal error.',
    [API_ERROR_CODES.sameFolderMove]:
      'The selected items are already in the destination folder; moving them into the same folder would only send the originals to the trash. Pick another destination.',
    [API_ERROR_CODES.destInsideSource]:
      'The destination is the selected folder itself or inside it. Pick another destination.',
    [API_ERROR_CODES.jobNotFinished]: 'The job is still running. Wait for it to finish, then try again.',
    [API_ERROR_CODES.engineClosed]: 'The DriveHop server is shutting down. Restart it, then try again.',
  },
  vi: {
    [CLIENT_ERROR_CODES.network]: 'Không kết nối được máy chủ DriveHop.',
    [CLIENT_ERROR_CODES.badResponse]: 'Máy chủ DriveHop trả về phản hồi không hợp lệ.',
    [CLIENT_ERROR_CODES.sessionExpired]:
      'Phiên đăng nhập đã hết hạn hoặc bạn không có quyền truy cập. Hãy tải lại trang để đăng nhập lại.',
    [API_ERROR_CODES.notConfigured]: 'Máy chủ chưa được cấu hình Google OAuth.',
    [API_ERROR_CODES.notFound]: 'Không tìm thấy dữ liệu được yêu cầu.',
    [API_ERROR_CODES.badRequest]: 'Yêu cầu không hợp lệ.',
    [API_ERROR_CODES.moveNotConfirmed]: 'Thao tác di chuyển chưa được xác nhận.',
    [API_ERROR_CODES.purgeNotConfirmed]: 'Thao tác xóa vĩnh viễn chưa được xác nhận.',
    [API_ERROR_CODES.needsReconnect]: 'Tài khoản này cần được kết nối lại với Google.',
    [API_ERROR_CODES.rateLimited]: 'Google đang giới hạn tần suất yêu cầu. Hãy thử lại sau ít phút.',
    [API_ERROR_CODES.providerError]: 'Google Drive báo lỗi khi xử lý yêu cầu.',
    [API_ERROR_CODES.internal]: 'Máy chủ DriveHop gặp lỗi nội bộ.',
    [API_ERROR_CODES.sameFolderMove]:
      'Mục được chọn đã nằm sẵn trong thư mục đích; di chuyển vào chính thư mục đó chỉ làm bản gốc bị chuyển vào thùng rác. Hãy chọn thư mục đích khác.',
    [API_ERROR_CODES.destInsideSource]:
      'Thư mục đích chính là thư mục được chọn hoặc nằm bên trong nó. Hãy chọn thư mục đích khác.',
    [API_ERROR_CODES.jobNotFinished]: 'Tác vụ vẫn đang chạy. Hãy đợi tác vụ kết thúc rồi làm lại.',
    [API_ERROR_CODES.engineClosed]: 'Máy chủ DriveHop đang tắt. Hãy khởi động lại máy chủ rồi thử lại.',
  },
});

const MISC = strings({
  en: {
    error: (message: string) => `Error: ${message}`,
    unknownError: 'Something went wrong.',
    connectFailed: (reason: string) => `Couldn't connect the Google account. ${reason}`,
    connectFailedCode: (code: string) => `Couldn't connect the Google account (error code: ${code}).`,
  },
  vi: {
    error: (message: string) => `Lỗi: ${message}`,
    unknownError: 'Đã xảy ra lỗi không xác định.',
    connectFailed: (reason: string) => `Kết nối tài khoản Google thất bại. ${reason}`,
    connectFailedCode: (code: string) => `Kết nối tài khoản Google thất bại (mã lỗi: ${code}).`,
  },
});

export function apiErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const known = Object.hasOwn(API_ERROR_TEXT, error.code)
      ? API_ERROR_TEXT[error.code as KnownApiErrorCode]
      : undefined;
    if (known) return known;
    return MISC.error(error.message || error.code);
  }
  return error instanceof Error ? MISC.error(error.message) : MISC.unknownError;
}

export function isNeedsReconnect(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === API_ERROR_CODES.needsReconnect;
}

const AUTH_ERROR_TEXT: Record<AuthErrorCode, string> = strings({
  en: {
    [AUTH_ERROR_CODES.accessDenied]: 'You declined to grant DriveHop access.',
    [AUTH_ERROR_CODES.oauthError]: 'Google reported an error during sign-in. Please try again.',
    [AUTH_ERROR_CODES.missingCode]: "Google didn't return an authorization code. Please try again.",
    [AUTH_ERROR_CODES.tokenExchangeFailed]:
      "Couldn't exchange the authorization code with Google. Please try again.",
    [AUTH_ERROR_CODES.noRefreshToken]:
      "Google didn't grant long-term access. Remove DriveHop's access in your Google account, then connect again.",
    [AUTH_ERROR_CODES.storageUnavailable]:
      "The server can't store sign-in data safely (the OS keyring is unavailable and MULTICLOUD_MASTER_KEY isn't set).",
    [AUTH_ERROR_CODES.driveScopeMissing]:
      "Google Drive access wasn't granted. Connect again and tick the box that lets DriveHop see and edit your Google Drive files.",
  },
  vi: {
    [AUTH_ERROR_CODES.accessDenied]: 'Bạn đã từ chối cấp quyền cho DriveHop.',
    [AUTH_ERROR_CODES.oauthError]: 'Google báo lỗi trong lúc đăng nhập. Hãy thử lại.',
    [AUTH_ERROR_CODES.missingCode]: 'Google không trả về mã xác thực. Hãy thử lại.',
    [AUTH_ERROR_CODES.tokenExchangeFailed]: 'Không đổi được mã xác thực với Google. Hãy thử lại.',
    [AUTH_ERROR_CODES.noRefreshToken]:
      'Google không cấp quyền truy cập lâu dài. Hãy gỡ quyền của DriveHop trong tài khoản Google rồi kết nối lại.',
    [AUTH_ERROR_CODES.storageUnavailable]:
      'Máy chủ không lưu được thông tin đăng nhập một cách an toàn (kho khóa của hệ điều hành không dùng được và chưa đặt MULTICLOUD_MASTER_KEY).',
    [AUTH_ERROR_CODES.driveScopeMissing]:
      'Bạn chưa cấp quyền Google Drive. Hãy kết nối lại và đánh dấu ô cho phép xem, sửa tệp Google Drive trên màn hình của Google.',
  },
});

export function authErrorText(code: string): string {
  const known = Object.hasOwn(AUTH_ERROR_TEXT, code) ? AUTH_ERROR_TEXT[code as AuthErrorCode] : undefined;
  return known ? MISC.connectFailed(known) : MISC.connectFailedCode(code);
}

export interface FileKind {
  icon: string;
  label: string;
}

const KIND = strings({
  en: {
    folder: 'Folder',
    googleFile: 'Google file',
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    text: 'Text',
    archive: 'Archive',
    spreadsheet: 'Spreadsheet',
    document: 'Document',
    presentation: 'Presentation',
    file: 'File',
  },
  vi: {
    folder: 'Thư mục',
    googleFile: 'Tệp Google',
    image: 'Hình ảnh',
    video: 'Video',
    audio: 'Âm thanh',
    text: 'Văn bản',
    archive: 'Tệp nén',
    spreadsheet: 'Bảng tính',
    document: 'Tài liệu',
    presentation: 'Trình chiếu',
    file: 'Tệp',
  },
});

/** Icon (decorative emoji) and type label for a Drive entry. */
export function fileKind(entry: Pick<FileEntry, 'isFolder' | 'mimeType'>): FileKind {
  if (entry.isFolder) return { icon: '📁', label: KIND.folder };
  const mime = entry.mimeType;
  if (mime === 'application/vnd.google-apps.document') return { icon: '📝', label: 'Google Docs' };
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return { icon: '📊', label: 'Google Sheets' };
  }
  if (mime === 'application/vnd.google-apps.presentation') {
    return { icon: '📽️', label: 'Google Slides' };
  }
  if (mime.startsWith('application/vnd.google-apps.')) return { icon: '🧩', label: KIND.googleFile };
  if (mime.startsWith('image/')) return { icon: '🖼️', label: KIND.image };
  if (mime.startsWith('video/')) return { icon: '🎬', label: KIND.video };
  if (mime.startsWith('audio/')) return { icon: '🎵', label: KIND.audio };
  if (mime === 'application/pdf') return { icon: '📕', label: 'PDF' };
  if (mime.startsWith('text/')) return { icon: '📄', label: KIND.text };
  if (/zip|compressed|tar|rar|7z/.test(mime)) return { icon: '🗜️', label: KIND.archive };
  if (/sheet|excel|csv/.test(mime)) return { icon: '📊', label: KIND.spreadsheet };
  if (/word|document/.test(mime)) return { icon: '📝', label: KIND.document };
  if (/presentation|powerpoint/.test(mime)) return { icon: '📽️', label: KIND.presentation };
  return { icon: '📄', label: KIND.file };
}

/** Folders first, then by name using the UI language's collation. */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, locale, { numeric: true, sensitivity: 'base' });
  });
}
