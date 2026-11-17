import { API_ERROR_CODES, SSE_EVENT_TYPES, apiUrl } from '@multicloud/shared';
import type { OpenStream, StreamHandlers } from '../lib/liveEvents.ts';
import type {
  Account,
  ApiError,
  Breadcrumb,
  CancelTransferResponse,
  CreateTransferRequest,
  CreateTransferResponse,
  FolderListing,
  FolderPathResponse,
  GetTransferResponse,
  ListAccountsResponse,
  ListFilesQuery,
  ListTransfersResponse,
  Quota,
  QuotaResponse,
  PurgeTrashedResult,
  RetryFailedTransferResponse,
  SseEvent,
  SseEventType,
  StatusResponse,
  TransferJob,
} from '@multicloud/shared';

/** Local (non-server) error codes produced by the client itself. */
export const CLIENT_ERROR_CODES = {
  /** fetch() rejected: nothing is listening or the connection was refused. */
  network: 'network',
  /** The response was not the JSON the contract promises (e.g. the dev proxy's error page). */
  badResponse: 'bad_response',
  /**
   * 401/403 that is not one of the API's own errors, or a redirect (Cloudflare Access sending an
   * expired session to its login page): the browser session is gone or not authorised.
   */
  sessionExpired: 'session_expired',
} as const;

export class ApiRequestError extends Error {
  readonly code: string;
  /** HTTP status, 0 when no response was received. */
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

/** True when the failure means "the API server cannot be reached", not "the API said no". */
export function isUnreachableError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return true;
  return error.code === CLIENT_ERROR_CODES.network || error.code === CLIENT_ERROR_CODES.badResponse;
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === CLIENT_ERROR_CODES.sessionExpired;
}

/** Callbacks of one event-stream connection (see `StreamHandlers`). */
export type EventHandlers = StreamHandlers;

/**
 * Names of the final event a server may send before it closes an idle stream on purpose. Not
 * part of `SseEvent` (it carries no job data); any payload is ignored. A plain server close is
 * handled the same way, so the client does not depend on the exact name.
 */
export const SSE_IDLE_EVENT_NAMES: readonly string[] = ['stream.idle', 'idle'];

/** Everything the UI needs from the backend. Implemented over HTTP and by the dev-only mock. */
export interface ApiClient {
  getStatus(): Promise<StatusResponse>;
  listAccounts(): Promise<Account[]>;
  deleteAccount(id: string): Promise<void>;
  getQuota(id: string): Promise<Quota>;
  listFiles(accountId: string, query?: ListFilesQuery): Promise<FolderListing>;
  getFolderPath(accountId: string, folderId: string): Promise<Breadcrumb[]>;
  listTransfers(): Promise<TransferJob[]>;
  /** Job including `items`. */
  getTransfer(id: string): Promise<TransferJob>;
  createTransfer(req: CreateTransferRequest): Promise<TransferJob>;
  cancelTransfer(id: string): Promise<TransferJob>;
  retryFailedTransfer(id: string): Promise<TransferJob>;
  /**
   * PERMANENTLY deletes (one bounded batch of) the originals a finished move job put in the trash.
   * Only call after the user confirmed it explicitly.
   */
  purgeTrashedSources(id: string): Promise<PurgeTrashedResult>;
  /** URL the browser navigates to (full page load) to link or re-link a Google account. */
  authStartUrl(): string;
  /**
   * Opens ONE connection of the live event stream; it never reconnects by itself (the policy is
   * in lib/liveEvents.ts). Returns the function that closes it.
   */
  openEvents: OpenStream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

const KNOWN_API_CODES: readonly string[] = Object.values(API_ERROR_CODES);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      // The API never redirects. A redirect means an auth proxy (Cloudflare Access) wants the user
      // to log in again; following it cross-origin would only fail as a CORS "network error".
      redirect: 'manual',
      headers: { accept: 'application/json', ...init?.headers },
    });
  } catch (cause) {
    throw new ApiRequestError(
      CLIENT_ERROR_CODES.network,
      cause instanceof Error ? cause.message : 'Network error',
      0,
    );
  }

  if (response.type === 'opaqueredirect') {
    throw new ApiRequestError(CLIENT_ERROR_CODES.sessionExpired, 'Redirected (login required)', 0);
  }

  let body: unknown;
  let parsed = false;
  try {
    const text = await response.text();
    if (text) {
      body = JSON.parse(text);
      parsed = true;
    }
  } catch {
    parsed = false;
  }

  if (!response.ok) {
    const apiError = parsed && isApiError(body) ? body : null;
    // 401/403 from the API itself (e.g. 401 needs_reconnect, 403 provider_error) keep their code;
    // anything else with those statuses comes from the auth layer in front of the API.
    if (
      (response.status === 401 || response.status === 403) &&
      !(apiError && KNOWN_API_CODES.includes(apiError.code))
    ) {
      throw new ApiRequestError(
        CLIENT_ERROR_CODES.sessionExpired,
        apiError?.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }
    if (apiError) {
      throw new ApiRequestError(apiError.code, apiError.message, response.status);
    }
    throw new ApiRequestError(
      CLIENT_ERROR_CODES.badResponse,
      `HTTP ${response.status}`,
      response.status,
    );
  }
  // 204 / empty success bodies are fine for calls whose result is not used (e.g. DELETE).
  if (!parsed && response.status !== 204) {
    throw new ApiRequestError(
      CLIENT_ERROR_CODES.badResponse,
      'Response was not JSON',
      response.status,
    );
  }
  return body as T;
}

function postJson<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Wire format of GET /api/events (see `SseEvent` in the shared contract): every event is named
 * after its type and its data is the JSON of the whole `{type, payload}` object. Anything else
 * (unknown type, payload that is not an object, malformed JSON) is ignored.
 */
function parseSseEvent(data: string, eventName: SseEventType): SseEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const knownTypes: readonly string[] = SSE_EVENT_TYPES;
  if (typeof value.type !== 'string' || !knownTypes.includes(value.type)) return null;
  if (value.type !== eventName) return null;
  if (!isRecord(value.payload)) return null;
  return value as unknown as SseEvent;
}

/** One EventSource; closed by us on any error so the browser's own reconnect loop never runs. */
export function openHttpEventStream(handlers: StreamHandlers): () => void {
  const source = new EventSource(apiUrl.events());
  let done = false;
  const finish = (callback: () => void): void => {
    if (done) return;
    done = true;
    source.close();
    callback();
  };
  source.onopen = () => {
    if (!done) handlers.onOpen();
  };
  for (const type of SSE_EVENT_TYPES) {
    source.addEventListener(type, (message: MessageEvent<string>) => {
      if (done) return;
      const event = parseSseEvent(message.data, type);
      if (event) handlers.onEvent(event);
    });
  }
  for (const name of SSE_IDLE_EVENT_NAMES) {
    source.addEventListener(name, () => finish(handlers.onIdle));
  }
  // Fired when the server ends the stream (readyState CONNECTING: the browser would reconnect on
  // its own, in a loop) and on HTTP errors (CLOSED). Either way: close and let the policy decide.
  source.onerror = () => finish(handlers.onClose);
  return () => {
    if (done) return;
    done = true;
    source.close();
  };
}

export function createHttpApiClient(): ApiClient {
  return {
    getStatus: () => request<StatusResponse>(apiUrl.status()),
    listAccounts: async () => (await request<ListAccountsResponse>(apiUrl.accounts())).accounts,
    deleteAccount: async (id) => {
      await request<unknown>(apiUrl.account(id), { method: 'DELETE' });
    },
    getQuota: async (id) => (await request<QuotaResponse>(apiUrl.accountQuota(id))).quota,
    listFiles: (accountId, query = {}) =>
      request<FolderListing>(apiUrl.accountFiles(accountId, query)),
    getFolderPath: async (accountId, folderId) =>
      (await request<FolderPathResponse>(apiUrl.accountFolderPath(accountId, folderId)))
        .breadcrumbs,
    listTransfers: async () => (await request<ListTransfersResponse>(apiUrl.transfers())).jobs,
    getTransfer: async (id) => (await request<GetTransferResponse>(apiUrl.transfer(id))).job,
    createTransfer: async (req) =>
      (await postJson<CreateTransferResponse>(apiUrl.transfers(), req)).job,
    cancelTransfer: async (id) =>
      (await postJson<CancelTransferResponse>(apiUrl.transferCancel(id))).job,
    retryFailedTransfer: async (id) =>
      (await postJson<RetryFailedTransferResponse>(apiUrl.transferRetryFailed(id))).job,
    purgeTrashedSources: (id) =>
      postJson<PurgeTrashedResult>(apiUrl.transferPurgeTrashed(id), { confirmPermanentDelete: true }),
    authStartUrl: () => apiUrl.authGoogleStart(),
    openEvents: openHttpEventStream,
  };
}
