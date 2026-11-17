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

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

const numberFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

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

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  connected: 'Đã kết nối',
  needs_reconnect: 'Cần kết nối lại',
};

export const JOB_STATUS_LABELS: Record<TransferJobStatus, string> = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  verifying: 'Đang kiểm tra',
  completed: 'Hoàn tất',
  completed_with_errors: 'Hoàn tất, có lỗi',
  failed: 'Thất bại',
  canceled: 'Đã hủy',
};

export const ITEM_STATUS_LABELS: Record<TransferItemStatus, string> = {
  pending: 'Đang chờ',
  running: 'Đang chuyển',
  done: 'Xong',
  failed: 'Lỗi',
  skipped: 'Bỏ qua',
  canceled: 'Đã hủy',
};

/**
 * "Thử lại" is offered for a finished job with failed OR canceled items (the server's retry re-runs
 * both). Totals carry no canceled count, but in a finished job every item that is neither done nor
 * failed was canceled: the engine never marks items skipped.
 */
export function canRetryJob(job: Pick<TransferJob, 'status' | 'totals'>): boolean {
  if (!isTerminalJobStatus(job.status) || job.status === 'completed') return false;
  return job.totals.failed > 0 || job.totals.done < job.totals.items;
}

/** Shown on a queued job: on Cloudflare a queued job may wait for the background runner (alarm). */
export const QUEUED_JOB_NOTE = 'Tác vụ đã vào hàng đợi, đang chờ tiến trình chạy nền bắt đầu xử lý…';

export const MODE_LABELS: Record<TransferMode, string> = {
  copy: 'Sao chép',
  move: 'Di chuyển',
};

// The Record<...Code, string> types make the compiler demand a text for every code of the shared
// contract, so a code added on the server cannot silently fall back to a raw string here.
const ITEM_ERROR_TEXT: Record<ItemErrorCode, string> = {
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
};

const ITEM_WARNING_TEXT: Record<ItemWarningCode, string> = {
  unshare_failed:
    'Đã sao chép xong nhưng chưa gỡ được quyền xem tạm thời đã cấp cho tài khoản đích trên tệp gốc. Hãy mở mục “Chia sẻ” của tệp gốc trong Google Drive và gỡ quyền đó.',
  trash_failed:
    'Đã sao chép xong nhưng không chuyển được bản gốc vào thùng rác. Bản gốc vẫn còn ở tài khoản nguồn.',
  purge_skipped:
    'Bản gốc trong thùng rác KHÔNG bị xóa vĩnh viễn (bản sao ở đích không còn, hoặc bạn đã khôi phục bản gốc).',
  purge_failed: 'Chưa xóa vĩnh viễn được bản gốc trong thùng rác. Hãy bấm xóa vĩnh viễn lại sau.',
};

const JOB_ERROR_TEXT: Record<JobErrorCode, string> = {
  ...ITEM_ERROR_TEXT,
  move_not_verified:
    'Một số mục chưa sao chép và kiểm tra được trọn vẹn nên bản gốc của chúng được giữ nguyên; các mục đã xong đã vào thùng rác của tài khoản nguồn.',
  move_not_confirmed:
    'Thao tác di chuyển chưa được xác nhận nên không có bản gốc nào bị chuyển vào thùng rác.',
  trash_failed:
    'Đã sao chép và kiểm tra xong nhưng một số bản gốc không chuyển được vào thùng rác; các bản gốc đó vẫn còn ở tài khoản nguồn.',
};

export interface FriendlyError {
  /** Vietnamese text, or the raw string when the code is not known. */
  text: string;
  /** Raw detail after "code: ", shown in small print when present. */
  detail?: string;
}

/** `code` or `code: detail` -> Vietnamese text. Unknown codes fall back to the raw string. */
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

const API_ERROR_TEXT: Record<KnownApiErrorCode, string> = {
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
};

export function apiErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const known = Object.hasOwn(API_ERROR_TEXT, error.code)
      ? API_ERROR_TEXT[error.code as KnownApiErrorCode]
      : undefined;
    if (known) return known;
    return error.message ? `Lỗi: ${error.message}` : `Lỗi: ${error.code}`;
  }
  return error instanceof Error ? `Lỗi: ${error.message}` : 'Đã xảy ra lỗi không xác định.';
}

export function isNeedsReconnect(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === API_ERROR_CODES.needsReconnect;
}

const AUTH_ERROR_TEXT: Record<AuthErrorCode, string> = {
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
};

export function authErrorText(code: string): string {
  const known = Object.hasOwn(AUTH_ERROR_TEXT, code) ? AUTH_ERROR_TEXT[code as AuthErrorCode] : undefined;
  return known
    ? `Kết nối tài khoản Google thất bại. ${known}`
    : `Kết nối tài khoản Google thất bại (mã lỗi: ${code}).`;
}

export interface FileKind {
  icon: string;
  label: string;
}

/** Icon (decorative emoji) and Vietnamese type label for a Drive entry. */
export function fileKind(entry: Pick<FileEntry, 'isFolder' | 'mimeType'>): FileKind {
  if (entry.isFolder) return { icon: '📁', label: 'Thư mục' };
  const mime = entry.mimeType;
  if (mime === 'application/vnd.google-apps.document') return { icon: '📝', label: 'Google Docs' };
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return { icon: '📊', label: 'Google Sheets' };
  }
  if (mime === 'application/vnd.google-apps.presentation') {
    return { icon: '📽️', label: 'Google Slides' };
  }
  if (mime.startsWith('application/vnd.google-apps.')) return { icon: '🧩', label: 'Tệp Google' };
  if (mime.startsWith('image/')) return { icon: '🖼️', label: 'Hình ảnh' };
  if (mime.startsWith('video/')) return { icon: '🎬', label: 'Video' };
  if (mime.startsWith('audio/')) return { icon: '🎵', label: 'Âm thanh' };
  if (mime === 'application/pdf') return { icon: '📕', label: 'PDF' };
  if (mime.startsWith('text/')) return { icon: '📄', label: 'Văn bản' };
  if (/zip|compressed|tar|rar|7z/.test(mime)) return { icon: '🗜️', label: 'Tệp nén' };
  if (/sheet|excel|csv/.test(mime)) return { icon: '📊', label: 'Bảng tính' };
  if (/word|document/.test(mime)) return { icon: '📝', label: 'Tài liệu' };
  if (/presentation|powerpoint/.test(mime)) return { icon: '📽️', label: 'Trình chiếu' };
  return { icon: '📄', label: 'Tệp' };
}

/** Folders first, then by name using Vietnamese collation. */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, 'vi', { numeric: true, sensitivity: 'base' });
  });
}
