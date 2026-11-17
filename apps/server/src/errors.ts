import { API_ERROR_CODES } from '@multicloud/shared';
import { HttpError } from '@multicloud/core';

// The host-independent parts live in @multicloud/core (shared with the Worker).
export { HttpError, badRequest, notFound, providerErrorToHttp } from '@multicloud/core';

/** 503 returned by everything that needs Google while the OAuth client is not configured. */
export function notConfigured(missing: readonly string[]): HttpError {
  const names = missing.length > 0 ? missing.join(', ') : 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET';
  return new HttpError(
    503,
    API_ERROR_CODES.notConfigured,
    `Máy chủ chưa được cấu hình. Thiếu biến môi trường: ${names}. Hãy thêm vào tệp .env ở thư mục gốc rồi khởi động lại máy chủ.`,
  );
}

/** 503 returned when no master key is available, so refresh tokens cannot be stored encrypted. */
export function tokenStorageUnavailable(): HttpError {
  return new HttpError(
    503,
    API_ERROR_CODES.notConfigured,
    'Không thể lưu token an toàn: kho thông tin xác thực của hệ điều hành không dùng được và chưa đặt biến môi trường MULTICLOUD_MASTER_KEY (base64 của 32 byte ngẫu nhiên).',
  );
}
