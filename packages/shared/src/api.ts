import type { Account, Breadcrumb, FolderListing, Quota } from './domain.ts';
import type { CreateTransferRequest, TransferJob } from './transfers.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Route patterns as registered on the server (`:param` placeholders). */
export const API_PATHS = {
  /** GET -> StatusResponse */
  status: '/api/status',
  /** GET -> ListAccountsResponse */
  accounts: '/api/accounts',
  /** DELETE -> DeleteAccountResponse */
  account: '/api/accounts/:id',
  /** GET -> 302 to Google, or 503 ApiError { code: 'not_configured' } */
  authGoogleStart: '/api/auth/google/start',
  /** GET (redirect target of Google) -> 302 back to the web UI, see AUTH_RESULT_PARAMS */
  authGoogleCallback: '/api/auth/google/callback',
  /** GET -> QuotaResponse */
  accountQuota: '/api/accounts/:id/quota',
  /** GET ?folderId=&pageToken= -> ListFilesResponse */
  accountFiles: '/api/accounts/:id/files',
  /** GET -> FolderPathResponse */
  accountFolderPath: '/api/accounts/:id/folders/:folderId/path',
  /** POST CreateTransferRequest -> CreateTransferResponse; GET -> ListTransfersResponse */
  transfers: '/api/transfers',
  /** GET -> GetTransferResponse */
  transfer: '/api/transfers/:id',
  /** POST -> CancelTransferResponse */
  transferCancel: '/api/transfers/:id/cancel',
  /** POST -> RetryFailedTransferResponse */
  transferRetryFailed: '/api/transfers/:id/retry-failed',
  /** POST { confirmPermanentDelete: true } -> PurgeTrashedResult */
  transferPurgeTrashed: '/api/transfers/:id/purge-trashed',
  /** GET, text/event-stream of SseEvent */
  events: '/api/events',
  /** POST SetupRequest -> SetupResponse (local app only, see StatusResponse.setup) */
  setup: '/api/setup',
} as const;

export type ApiPathKey = keyof typeof API_PATHS;

const enc = encodeURIComponent;

/** Concrete URL builders for clients (path only, same-origin). */
export const apiUrl = {
  status: (): string => API_PATHS.status,
  accounts: (): string => API_PATHS.accounts,
  account: (id: string): string => `/api/accounts/${enc(id)}`,
  authGoogleStart: (): string => API_PATHS.authGoogleStart,
  accountQuota: (id: string): string => `/api/accounts/${enc(id)}/quota`,
  accountFiles: (id: string, query: ListFilesQuery = {}): string => {
    const params = new URLSearchParams();
    if (query.folderId) params.set('folderId', query.folderId);
    if (query.pageToken) params.set('pageToken', query.pageToken);
    const qs = params.toString();
    return `/api/accounts/${enc(id)}/files${qs ? `?${qs}` : ''}`;
  },
  accountFolderPath: (id: string, folderId: string): string =>
    `/api/accounts/${enc(id)}/folders/${enc(folderId)}/path`,
  transfers: (): string => API_PATHS.transfers,
  setup: (): string => API_PATHS.setup,
  transfer: (id: string): string => `/api/transfers/${enc(id)}`,
  transferCancel: (id: string): string => `/api/transfers/${enc(id)}/cancel`,
  transferRetryFailed: (id: string): string => `/api/transfers/${enc(id)}/retry-failed`,
  transferPurgeTrashed: (id: string): string => `/api/transfers/${enc(id)}/purge-trashed`,
  events: (): string => API_PATHS.events,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Body of every non-2xx JSON response. */
export interface ApiError {
  code: string;
  message: string;
}

/** Well-known values of `ApiError.code`. Servers may return other strings too. */
export const API_ERROR_CODES = {
  notConfigured: 'not_configured',
  notFound: 'not_found',
  badRequest: 'bad_request',
  moveNotConfirmed: 'move_not_confirmed',
  /** 400: purge-trashed without `confirmPermanentDelete: true`. */
  purgeNotConfirmed: 'purge_not_confirmed',
  needsReconnect: 'needs_reconnect',
  rateLimited: 'rate_limited',
  providerError: 'provider_error',
  internal: 'internal',
  /** 400: a same-account move whose source already is in the destination folder. */
  sameFolderMove: 'same_folder_move',
  /** 400: the destination folder is a selected folder itself or lies inside one. */
  destInsideSource: 'dest_inside_source',
  /** 409: retry-failed on a job that is still queued / running / verifying. */
  jobNotFinished: 'job_not_finished',
  /** 503: the server is shutting down. */
  engineClosed: 'engine_closed',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/** 503 body of GET /api/auth/google/start when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing. */
export interface NotConfiguredError extends ApiError {
  code: 'not_configured';
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/** GET /api/status */
export interface StatusResponse {
  /** True when all required configuration (Google OAuth client) is present. */
  configured: boolean;
  /** Names of the missing environment variables, e.g. ['GOOGLE_CLIENT_ID']. */
  missing: string[];
  /** False when the OS keyring cannot be used and MULTICLOUD_MASTER_KEY is the fallback. */
  keyringAvailable: boolean;
  /**
   * Present only when this server lets the web UI save the Google OAuth client (the local app).
   * Absent on hosts configured another way (the Cloudflare Worker uses secrets).
   */
  setup?: SetupInfo;
}

export interface SetupInfo {
  /** True when POST /api/setup is accepted now (no account is linked yet). */
  allowed: boolean;
  /** Redirect URI to register on the OAuth client, e.g. http://localhost:8787/api/auth/google/callback */
  redirectUri: string;
  /** Origin of the web UI, to register as an authorized JavaScript origin if asked. */
  webOrigin: string;
}

/** POST /api/setup */
export interface SetupRequest {
  clientId: string;
  clientSecret: string;
}

/** POST /api/setup. The server restarts right after answering; poll /api/status. */
export interface SetupResponse {
  ok: true;
}

/** GET /api/accounts */
export interface ListAccountsResponse {
  accounts: Account[];
}

/** DELETE /api/accounts/:id (disconnects locally; never touches files in the cloud) */
export interface DeleteAccountResponse {
  ok: true;
}

/**
 * GET /api/auth/google/callback finishes with a 302 to WEB_ORIGIN carrying one of these
 * query parameters: `connected=<accountId>` on success or `auth_error=<code>` on failure.
 */
export const AUTH_RESULT_PARAMS = {
  connected: 'connected',
  error: 'auth_error',
} as const;

/** Every value the `auth_error` query parameter can take. */
export const AUTH_ERROR_CODES = {
  accessDenied: 'access_denied',
  oauthError: 'oauth_error',
  missingCode: 'missing_code',
  tokenExchangeFailed: 'token_exchange_failed',
  noRefreshToken: 'no_refresh_token',
  storageUnavailable: 'storage_unavailable',
  /** The user left the Drive permission unticked on Google's consent screen. */
  driveScopeMissing: 'drive_scope_missing',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/** Query string Google sends to GET /api/auth/google/callback. */
export interface AuthGoogleCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

/** GET /api/accounts/:id/quota */
export interface QuotaResponse {
  quota: Quota;
}

/** Query of GET /api/accounts/:id/files. `folderId` defaults to ROOT_FOLDER_ID. */
export interface ListFilesQuery {
  folderId?: string;
  pageToken?: string;
}

/** GET /api/accounts/:id/files */
export type ListFilesResponse = FolderListing;

/** GET /api/accounts/:id/folders/:folderId/path (root first, requested folder last) */
export interface FolderPathResponse {
  breadcrumbs: Breadcrumb[];
}

/** POST /api/transfers */
export type CreateTransferBody = CreateTransferRequest;

/** POST /api/transfers -> 201 */
export interface CreateTransferResponse {
  job: TransferJob;
}

/** GET /api/transfers (jobs without `items`, newest first) */
export interface ListTransfersResponse {
  jobs: TransferJob[];
}

/** GET /api/transfers/:id (job with `items`) */
export interface GetTransferResponse {
  job: TransferJob;
}

/** POST /api/transfers/:id/cancel */
export interface CancelTransferResponse {
  job: TransferJob;
}

/** POST /api/transfers/:id/retry-failed */
export interface RetryFailedTransferResponse {
  job: TransferJob;
}

// ---------------------------------------------------------------------------
// Limits shown in the UI
// ---------------------------------------------------------------------------

const GIB = 1024 ** 3;

export const GOOGLE_LIMITS = {
  /** Google Drive upload/copy quota per account per 24 hours (750 GB). */
  dailyBytesPerAccount: 750 * GIB,
  /** Largest single file that can be copied within the daily quota (750 GB). */
  maxCopyFileBytes: 750 * GIB,
} as const;
