// Host-independent (no Fastify, no `node:` import): shared by the Node server and the Worker.
import { API_ERROR_CODES } from '@multicloud/shared';
import type { ApiError, ProviderError } from '@multicloud/shared';

/** An error that already knows its HTTP status and public `{ code, message }` body. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, API_ERROR_CODES.badRequest, message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, API_ERROR_CODES.notFound, message);
}

/** Maps a ProviderError to the HTTP status and public body of the API. */
export function providerErrorToHttp(err: ProviderError): { statusCode: number; body: ApiError } {
  switch (err.kind) {
    case 'auth':
      return {
        statusCode: 401,
        body: {
          code: API_ERROR_CODES.needsReconnect,
          message: 'Tài khoản cần được kết nối lại với Google.',
        },
      };
    case 'rate_limit':
      return {
        statusCode: 429,
        body: {
          code: API_ERROR_CODES.rateLimited,
          message: 'Google đang giới hạn tần suất yêu cầu. Hãy thử lại sau ít phút.',
        },
      };
    case 'not_found':
      return {
        statusCode: 404,
        body: { code: API_ERROR_CODES.notFound, message: 'Không tìm thấy tệp hoặc thư mục.' },
      };
    case 'forbidden':
      return {
        statusCode: 403,
        body: {
          code: API_ERROR_CODES.providerError,
          message: 'Google từ chối yêu cầu: tài khoản không có quyền thực hiện thao tác này.',
        },
      };
    case 'server':
    case 'unknown':
      return {
        statusCode: 502,
        body: { code: API_ERROR_CODES.providerError, message: 'Google Drive trả về lỗi. Hãy thử lại.' },
      };
  }
}
