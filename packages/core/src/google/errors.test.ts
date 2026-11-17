import { describe, expect, it } from 'vitest';
import { ProviderError } from '@multicloud/shared';
import { mapGoogleError } from './errors.ts';

const driveError = (code: number, reason: string, message = 'boom') => ({
  error: { code, message, errors: [{ domain: 'usageLimits', reason, message }] },
});

describe('mapGoogleError', () => {
  it('maps auth failures', () => {
    const e401 = mapGoogleError(401, driveError(401, 'authError', 'Invalid Credentials'));
    expect(e401).toBeInstanceOf(ProviderError);
    expect(e401).toMatchObject({ kind: 'auth', retryable: false, status: 401, code: 'authError' });
    const grant = mapGoogleError(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    expect(grant).toMatchObject({ kind: 'auth', retryable: false, status: 400 });
    expect(grant.message).toBe('Google Drive 400 invalid_grant: Token has been expired or revoked.');
  });

  it('maps rate limits and server errors as retryable', () => {
    expect(mapGoogleError(403, driveError(403, 'userRateLimitExceeded'))).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(mapGoogleError(403, driveError(403, 'rateLimitExceeded'))).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(mapGoogleError(429, driveError(429, 'rateLimitExceeded'))).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(mapGoogleError(429, undefined)).toMatchObject({ kind: 'rate_limit', retryable: true });
    for (const status of [500, 502, 503, 504]) {
      expect(mapGoogleError(status, 'Backend Error')).toMatchObject({ kind: 'server', retryable: true, status });
    }
  });

  it('maps the remaining statuses', () => {
    expect(mapGoogleError(404, driveError(404, 'notFound'))).toMatchObject({ kind: 'not_found', retryable: false, code: 'notFound' });
    expect(mapGoogleError(403, driveError(403, 'storageQuotaExceeded'))).toMatchObject({
      kind: 'forbidden',
      retryable: false,
      code: 'storageQuotaExceeded',
    });
    expect(mapGoogleError(403, driveError(403, 'insufficientFilePermissions'))).toMatchObject({ kind: 'forbidden' });
    expect(mapGoogleError(400, driveError(400, 'badRequest'))).toMatchObject({ kind: 'unknown', retryable: false });
    expect(mapGoogleError(409, undefined)).toMatchObject({ kind: 'unknown', status: 409 });
  });

  it('formats the message and parses text bodies', () => {
    const fromText = mapGoogleError(404, JSON.stringify(driveError(404, 'notFound', 'File not found: abc.')));
    expect(fromText.message).toBe('Google Drive 404 notFound: File not found: abc.');
    expect(mapGoogleError(502, '<html>bad gateway</html>').message).toBe('Google Drive 502: <html>bad gateway</html>');
    expect(mapGoogleError(500, undefined).message).toBe('Google Drive 500: HTTP 500');
    const long = mapGoogleError(400, 'x'.repeat(1000));
    expect(long.message.length).toBeLessThan(340);
  });

  it('never repeats a token and attaches no cause', () => {
    const error = mapGoogleError(
      403,
      driveError(
        403,
        'forbidden',
        'denied for Bearer ya29.A0secret and 1//0gRefreshSecret GOCSPX-clientSecret https://www.googleapis.com/upload/drive/v3/files?upload_id=CAPABILITY',
      ),
    );
    for (const secret of ['ya29.A0secret', '1//0gRefreshSecret', 'GOCSPX-clientSecret', 'CAPABILITY']) {
      expect(error.message).not.toContain(secret);
    }
    expect(error.cause).toBeUndefined();
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(mapGoogleError(429, undefined, new Headers({ 'Retry-After': '7' })).retryAfterMs).toBe(7000);
    const date = new Date(Date.now() + 60_000).toUTCString();
    const fromDate = mapGoogleError(503, undefined, new Headers({ 'Retry-After': date })).retryAfterMs ?? -1;
    expect(fromDate).toBeGreaterThan(50_000);
    expect(fromDate).toBeLessThanOrEqual(60_000);
    expect(mapGoogleError(503, undefined, new Headers({ 'Retry-After': 'soon' })).retryAfterMs).toBeUndefined();
    expect(mapGoogleError(503, undefined).retryAfterMs).toBeUndefined();
  });
});
