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
    `The server is not configured. Missing environment variables: ${names}. Enter your OAuth client on the setup screen, or add them to the .env file and restart the server.`,
  );
}

/** 503 returned when no master key is available, so refresh tokens cannot be stored encrypted. */
export function tokenStorageUnavailable(): HttpError {
  return new HttpError(
    503,
    API_ERROR_CODES.notConfigured,
    'Cannot store tokens safely: the OS credential store is unavailable and MULTICLOUD_MASTER_KEY (base64 of 32 random bytes) is not set.',
  );
}
