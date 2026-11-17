import {
  API_ERROR_CODES,
  ITEM_ERROR_CODES,
  ITEM_WARNING_CODES,
  JOB_ERROR_CODES,
  PROVIDER_ERROR_CODES,
  ProviderError,
} from '@multicloud/shared';
import type { ItemErrorCode, ItemWarningCode, JobErrorCode } from '@multicloud/shared';

/** Codes of the typed error the engine's public methods reject with (all are shared API error codes). */
export const TRANSFER_ERROR_CODES = {
  badRequest: API_ERROR_CODES.badRequest,
  moveNotConfirmed: API_ERROR_CODES.moveNotConfirmed,
  sameFolderMove: API_ERROR_CODES.sameFolderMove,
  destInsideSource: API_ERROR_CODES.destInsideSource,
  notFound: API_ERROR_CODES.notFound,
  jobNotFinished: API_ERROR_CODES.jobNotFinished,
  engineClosed: API_ERROR_CODES.engineClosed,
} as const;

export type TransferErrorCode = (typeof TRANSFER_ERROR_CODES)[keyof typeof TRANSFER_ERROR_CODES];

const HTTP_STATUS: Record<TransferErrorCode, number> = {
  bad_request: 400,
  move_not_confirmed: 400,
  same_folder_move: 400,
  dest_inside_source: 400,
  not_found: 404,
  job_not_finished: 409,
  engine_closed: 503,
};

/** Rejection type of createJob / cancel / retryFailed. `code` is stable; `httpStatus` is a hint for routes. */
export class TransferError extends Error {
  readonly code: TransferErrorCode;
  readonly httpStatus: number;

  constructor(code: TransferErrorCode, message: string) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

export function isTransferError(value: unknown): value is TransferError {
  return value instanceof TransferError;
}

// The code lists live in the shared contract so the web UI maps exactly what is emitted here.
export { ITEM_ERROR_CODES, ITEM_WARNING_CODES, JOB_ERROR_CODES };
export type { ItemErrorCode, ItemWarningCode, JobErrorCode };

/** Internal: thrown when the job's AbortSignal fired. Never surfaces to callers. */
export class CancelError extends Error {
  constructor() {
    super('canceled');
    this.name = 'CancelError';
  }
}

export function isCancelError(value: unknown): value is CancelError {
  return value instanceof CancelError;
}

/** Internal: an item failure with an explicit machine code. */
export class ItemFailure extends Error {
  readonly code: ItemErrorCode;

  constructor(code: ItemErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'ItemFailure';
    this.code = code;
  }
}

interface ProviderErrorLike {
  kind: string;
  retryable: boolean;
  /** HTTP status of the provider's answer, when there was one. */
  status?: number;
  code?: string;
  message: string;
}

/** `instanceof` first; the structural fallback covers a duplicated module instance. */
export function asProviderError(value: unknown): ProviderErrorLike | undefined {
  if (value instanceof ProviderError) return value;
  if (
    value instanceof Error &&
    typeof (value as Partial<ProviderErrorLike>).kind === 'string' &&
    typeof (value as Partial<ProviderErrorLike>).retryable === 'boolean'
  ) {
    return value as unknown as ProviderErrorLike;
  }
  return undefined;
}

export function isRetryable(value: unknown): boolean {
  return asProviderError(value)?.retryable === true;
}

const PROVIDER_KINDS: readonly string[] = ['rate_limit', 'auth', 'not_found', 'forbidden', 'server', 'unknown'];

/** Only the well-known provider codes may open an item error; any other code stays in the detail. */
const KNOWN_PROVIDER_CODES: readonly string[] = Object.values(PROVIDER_ERROR_CODES);

export function errorCodeOf(value: unknown): string {
  if (isCancelError(value)) return 'canceled';
  if (value instanceof ItemFailure) return value.code;
  const provider = asProviderError(value);
  if (provider) {
    if (provider.code !== undefined && KNOWN_PROVIDER_CODES.includes(provider.code)) return provider.code;
    return PROVIDER_KINDS.includes(provider.kind) ? provider.kind : 'unknown';
  }
  return 'unknown';
}

const SECRET_PATTERNS: readonly RegExp[] = [
  // Authorization header values and Google token shapes (access, refresh, client secret, JWT).
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bya29\.[A-Za-z0-9._-]+/g,
  /\b1\/\/[A-Za-z0-9_-]{6,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g,
  // JSON bodies: "refresh_token": "<value>" (any value shape, e.g. an unprefixed client secret).
  /"(?:access_token|refresh_token|id_token|client_secret|upload_id)"\s*:\s*"[^"]*"/gi,
  // Credentials in URLs and form bodies; `upload_id` is the capability of a resumable upload session.
  /\b(?:access_token|refresh_token|id_token|client_secret|upload_id|code|key|token)=[^&\s"']+/gi,
];

/**
 * Removes anything that looks like a credential. Error details are stored, logged, sent to the
 * browser (item / job `error`, item `warning`) and partly come from upstream error messages, so
 * this is the single place that guarantees no token leaves the server that way.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return redactSecrets(value.message);
  return redactSecrets(typeof value === 'string' ? value : String(value));
}

/** `<code>: <detail>` (single line, bounded length), or just `<code>` when there is no useful detail. */
export function formatError(value: unknown, codeOverride?: ItemWarningCode | JobErrorCode): string {
  const code = codeOverride ?? errorCodeOf(value);
  let detail = messageOf(value).replace(/\s+/g, ' ').trim();
  const rawCode = asProviderError(value)?.code;
  if (rawCode !== undefined && !KNOWN_PROVIDER_CODES.includes(rawCode)) detail = `[${rawCode}] ${detail}`;
  if (codeOverride !== undefined && codeOverride !== errorCodeOf(value)) {
    detail = `${errorCodeOf(value)}: ${detail}`;
  }
  if (!detail || detail === code) return code;
  return `${code}: ${detail.slice(0, 500)}`;
}
