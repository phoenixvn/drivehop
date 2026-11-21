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
          message: 'The account needs to be reconnected to Google.',
        },
      };
    case 'rate_limit':
      return {
        statusCode: 429,
        body: {
          code: API_ERROR_CODES.rateLimited,
          message: 'Google is rate-limiting requests. Try again in a few minutes.',
        },
      };
    case 'not_found':
      return {
        statusCode: 404,
        body: { code: API_ERROR_CODES.notFound, message: 'File or folder not found.' },
      };
    case 'forbidden':
      return {
        statusCode: 403,
        body: {
          code: API_ERROR_CODES.providerError,
          message: 'Google refused the request: the account is not allowed to do this.',
        },
      };
    case 'server':
    case 'unknown':
      return {
        statusCode: 502,
        body: { code: API_ERROR_CODES.providerError, message: 'Google Drive returned an error. Please try again.' },
      };
  }
}
