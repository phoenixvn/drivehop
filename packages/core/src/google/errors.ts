// Host-independent: Web-standard APIs only (no `node:` import, no `Buffer`, no `process`).
import { ProviderError } from '@multicloud/shared';
import type { ProviderErrorKind } from '@multicloud/shared';

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const MAX_DETAIL_LENGTH = 300;
/** Upper bound for a Retry-After we honour (a broken header must not park a job for days). */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

// Token shapes that must never end up in a message, even when Google echoes them back.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bya29\.[A-Za-z0-9._~+/=-]+/g,
  /\b1\/\/[A-Za-z0-9._~+/=-]+/g,
  /\bGOCSPX-[A-Za-z0-9._~+/=-]+/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
  /([?&](?:upload_id|access_token|code|refresh_token|key)=)[^&\s]+/gi,
];

function scrub(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix: unknown) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]',
    );
  }
  return out;
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else {
    const date = Date.parse(raw);
    if (Number.isNaN(date)) return undefined;
    ms = date - Date.now();
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

/**
 * Converts a non-2xx response of a Google endpoint (Drive v3, the OAuth token / revoke / userinfo
 * endpoints) into a ProviderError. Semantics carried over from the former
 * apps/server/src/google/errors.ts:
 *
 * - 401, or OAuth `error: "invalid_grant"`                -> kind 'auth', not retryable
 * - 429, or 403 with reason rateLimitExceeded /
 *   userRateLimitExceeded                                  -> kind 'rate_limit', retryable
 * - 5xx                                                    -> kind 'server', retryable
 * - 404 -> 'not_found', other 403 -> 'forbidden', anything else -> 'unknown'; not retryable
 *
 * `body` is the parsed JSON body, the raw text, or undefined. Drive errors look like
 * `{ error: { code, message, errors: [{ reason }] } }`, token endpoint errors like
 * `{ error: 'invalid_grant', error_description }`. `ProviderError.status` is `status`,
 * `ProviderError.code` is the Drive reason when there is one, the message is
 * `Google Drive <status> <reason>: <detail up to 300 chars>` and must never contain a token.
 * `headers`, when given, supplies `Retry-After` (seconds or an HTTP date), reported as
 * `ProviderError.retryAfterMs`. No `cause` is attached.
 */
export function mapGoogleError(status: number, body: unknown, headers?: Headers): ProviderError {
  let reason: string | undefined;
  let oauthError: string | undefined;
  let message = '';

  const parsed = parseBody(body);
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (typeof error === 'string') {
      oauthError = error;
      message = typeof parsed.error_description === 'string' ? parsed.error_description : error;
    } else if (isRecord(error)) {
      if (typeof error.message === 'string') message = error.message;
      const first = Array.isArray(error.errors) ? (error.errors[0] as unknown) : undefined;
      if (isRecord(first) && typeof first.reason === 'string' && first.reason !== '') reason = first.reason;
      else if (typeof error.status === 'string' && error.status !== '') reason = error.status;
    }
  } else if (typeof body === 'string') {
    message = body;
  }
  if (message.trim() === '') message = `HTTP ${status}`;

  let kind: ProviderErrorKind = 'unknown';
  let retryable = false;
  if (oauthError === 'invalid_grant' || status === 401) {
    kind = 'auth';
  } else if (status === 429 || (status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
    kind = 'rate_limit';
    retryable = true;
  } else if (status >= 500 && status <= 599) {
    kind = 'server';
    retryable = true;
  } else if (status === 404) {
    kind = 'not_found';
  } else if (status === 403) {
    kind = 'forbidden';
  }

  const label = reason ?? oauthError;
  const clean = scrub(message.replace(/\s+/g, ' ').trim());
  const detail = clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
  const wait = retryAfterMs(headers);
  return new ProviderError(`Google Drive ${status}${label === undefined ? '' : ` ${scrub(label)}`}: ${detail}`, {
    kind,
    retryable,
    status,
    ...(reason === undefined ? {} : { code: reason }),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
  });
}
