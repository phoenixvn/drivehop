// Host-independent networking: plain fetch against the Drive v3 REST API, no googleapis.
// (The `Readable` streams of the CloudProvider interface come from `node:stream`, which both
// hosts provide: Node natively, Workers through the `nodejs_compat` flag. It is the only `node:`
// import of the google folder.)
//
// Endpoints (developers.google.com/workspace/drive/api/reference/rest/v3):
//   files.list / files.get (alt=media for content) / files.create / files.copy / files.update
//   files.generateIds, permissions.list / create / delete, about.get
//   resumable upload: developers.google.com/workspace/drive/api/guides/manage-uploads
// There is NO call to files.delete, files.emptyTrash or any other permanent-delete endpoint.
import { Readable } from 'node:stream';
import { PRESET_ID_CONFLICT_STATUS, PROVIDER_ERROR_CODES, ProviderError, SHORTCUT_MIME_TYPE } from '@multicloud/shared';
import type {
  CloudProvider,
  FileEntry,
  FolderListing,
  PresetIdOptions,
  ProviderAccountInfo,
  ProviderId,
  Quota,
  ResumableUploadParams,
  ShareOptions,
} from '@multicloud/shared';
import { mapGoogleError } from './errors.ts';
import { isHttpsUrl } from './oauth.ts';

export interface GoogleDriveProviderOptions {
  /** Local id of the account this instance is bound to; copied into every `FileEntry.accountId`. */
  accountId: string;
  /**
   * Returns a valid access token for the account. After a 401 the provider calls it ONCE more with
   * `{ forceRefresh: true }` and repeats the request; a second 401 becomes a ProviderError of kind
   * 'auth'. A function that ignores the argument (`() => Promise<string>`) is accepted.
   */
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  /** Called when Google reports that the credentials no longer work (kind 'auth'). Must not throw. */
  onAuthError?: () => void;
  /** Default: the global `fetch`. Hosts wrap it to count subrequests. */
  fetch?: typeof fetch;
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number;
  /** Waits between retries of a single request / upload chunk. Default: a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_V2_ABOUT_URL = 'https://www.googleapis.com/drive/v2/about';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

/** Only the fields the app needs; keeps responses small. */
export const DRIVE_FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed,capabilities(canCopy,canTrash,canDownload),shortcutDetails(targetId)';

/** Resumable chunks must be multiples of 256 KiB, except the last one (manage-uploads guide). */
export const DRIVE_UPLOAD_CHUNK_UNIT = 256 * 1024;
export const DRIVE_DEFAULT_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

/** ProviderError.code used when `copyWithin` is asked to copy a folder (files.copy cannot). */
export const DRIVE_FOLDER_COPY_NOT_SUPPORTED = 'folder_copy_not_supported';

/**
 * appProperties key that realises a preset id through a marker where Drive cannot take the id
 * itself: Drive does not support pre-generated ids for the creation of Google Workspace files
 * (create-file guide), and a copy of a Docs/Sheets/Slides file is such a creation.
 */
export const DRIVE_PRESET_ID_MARKER_KEY = 'multicloudPresetId';

const LIST_PAGE_SIZE = 200;
const GENERATE_IDS_MAX = 1000;
/** Retries of one API request after a rate limit / 5xx / network failure. */
const MAX_REQUEST_RETRIES = 3;
/** Retries of one upload chunk. */
const MAX_CHUNK_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;
const EMPTY = new Uint8Array(0);

type QueryValue = string | number | boolean | undefined;

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path below the Drive v3 base, or an absolute googleapis.com URL. */
  path: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  headers?: Record<string, string>;
  /** Safe to repeat after a 5xx / network failure (a rate-limited request was not processed). */
  idempotent: boolean;
  /** The request carries a preset id: a 409 then means "this id is in use". */
  presetId?: boolean;
  /**
   * A status that, when it answers a REPEAT of a request whose earlier attempt may have landed,
   * means that earlier attempt succeeded (409 for preset-id creates, 404 for deletes).
   */
  acceptAfterRetry?: number;
  /**
   * Follow up to a few redirects (media download). The bearer token is only re-sent to
   * googleapis.com. API calls never follow redirects.
   */
  follow?: boolean;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
  trashed?: boolean;
  capabilities?: { canCopy?: boolean; canTrash?: boolean; canDownload?: boolean };
  shortcutDetails?: { targetId?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Escapes a value for use inside single quotes in a Drive `q` expression (search-files guide). */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** True for https URLs on googleapis.com (the only place a bearer token may be sent to). */
function isGoogleApisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'googleapis.com' || url.hostname.endsWith('.googleapis.com'));
  } catch {
    return false;
  }
}

/** Rounds a requested chunk size to a positive multiple of 256 KiB (default 8 MiB). */
function normalizeChunkSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DRIVE_DEFAULT_UPLOAD_CHUNK_SIZE;
  return Math.max(1, Math.round(requested / DRIVE_UPLOAD_CHUNK_UNIT)) * DRIVE_UPLOAD_CHUNK_UNIT;
}

function isGoogleNativeMimeType(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_NATIVE_PREFIX) && mimeType !== DRIVE_FOLDER_MIME_TYPE;
}

function toBytes(piece: unknown): Uint8Array {
  if (piece instanceof Uint8Array) return piece;
  if (typeof piece === 'string') return new TextEncoder().encode(piece);
  if (piece instanceof ArrayBuffer) return new Uint8Array(piece);
  if (ArrayBuffer.isView(piece)) return new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength);
  throw new ProviderError('The upload stream produced data that is not bytes', { kind: 'unknown', retryable: false });
}

/** Re-slices a byte stream into chunks of exactly `size` bytes (the last one may be shorter). */
async function* fixedSizeChunks(stream: AsyncIterable<unknown>, size: number): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const piece of stream) {
    let rest = toBytes(piece);
    while (filled + rest.length >= size) {
      const take = size - filled;
      buffer.set(rest.subarray(0, take), filled);
      yield buffer;
      buffer = new Uint8Array(size);
      filled = 0;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      buffer.set(rest, filled);
      filled += rest.length;
    }
  }
  if (filled > 0) yield buffer.subarray(0, filled);
}

/** Bytes Google has stored, from the `Range: bytes=0-N` header of a 308 response. */
function confirmedBytes(rangeHeader: string | null): number {
  if (rangeHeader === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(rangeHeader.trim());
  return match?.[1] === undefined ? 0 : Number(match[1]) + 1;
}

async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}

function networkError(): ProviderError {
  // Never the fetch error's message: it can contain the request URL (an upload session capability).
  return new ProviderError('Google Drive could not be reached', { kind: 'server', retryable: true });
}

function unexpected(message: string): ProviderError {
  return new ProviderError(message, { kind: 'unknown', retryable: false });
}

/**
 * A 409 is reserved for preset-id conflicts (PresetIdOptions in @multicloud/shared): any other
 * 409 loses its status.
 */
function withoutConflictStatus(error: ProviderError): ProviderError {
  if (error.status !== PRESET_ID_CONFLICT_STATUS) return error;
  return new ProviderError(error.message, {
    kind: error.kind,
    retryable: error.retryable,
    code: error.code ?? 'conflict',
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  });
}

function presetConflict(error: ProviderError | undefined): ProviderError {
  return new ProviderError(error?.message ?? 'Google Drive 409: the preset id is already in use', {
    kind: 'unknown',
    retryable: false,
    status: PRESET_ID_CONFLICT_STATUS,
    code: error?.code ?? 'preset_id_in_use',
  });
}

/**
 * One instance per connected account. Every method rejects with ProviderError (`mapGoogleError`).
 * There is no permanent-delete call anywhere: `trash` is the only destructive operation.
 * `presetId` semantics: see `PresetIdOptions` in @multicloud/shared.
 *
 * Preset ids (create-file and manage-uploads guides): `files.generateIds` ids are passed as the
 * `id` of files.create (folders, resumable uploads) and files.copy; a repeat returns 409 Conflict
 * and creates nothing. Exception: a copy of a Google-native file cannot take a preset id, so it
 * carries the marker `appProperties.multicloudPresetId = <presetId>` instead, and `getFile(presetId)`
 * falls back to a marker search when the id itself does not exist.
 */
export function createGoogleDriveProvider(options: GoogleDriveProviderOptions): CloudProvider {
  const { accountId } = options;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const reportAuth = (): void => {
    if (options.onAuthError === undefined) return;
    try {
      options.onAuthError();
    } catch {
      // Marking the account must never mask the original error.
    }
  };

  /** Normalises anything that escapes a public method into a ProviderError, reporting auth failures. */
  const fail = (err: unknown): ProviderError => {
    const error = err instanceof ProviderError ? err : unexpected('Google Drive request failed unexpectedly');
    if (error.kind === 'auth') reportAuth();
    return error;
  };

  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw fail(err);
    }
  };

  const token = async (forceRefresh: boolean): Promise<string> => {
    let value: string;
    try {
      value = await (forceRefresh ? options.getAccessToken({ forceRefresh: true }) : options.getAccessToken());
    } catch (err) {
      // A ProviderError (e.g. 'auth' for invalid_grant) passes through; anything else is not proof
      // that the credentials are dead, so it must not mark the account as needing a reconnect.
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('No access token could be obtained for this account', { kind: 'unknown', retryable: false });
    }
    if (typeof value !== 'string' || value === '') {
      throw new ProviderError('No access token available', { kind: 'auth', retryable: false });
    }
    return value;
  };

  const backoff = (retry: number, error: ProviderError | undefined): number => {
    if (error?.retryAfterMs !== undefined) return Math.min(MAX_BACKOFF_MS * 2, error.retryAfterMs);
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry);
    return base + Math.floor(Math.random() * 250);
  };

  const buildUrl = (spec: RequestSpec): string => {
    const url = new URL(spec.path.startsWith('https://') ? spec.path : `${DRIVE_API_BASE}${spec.path}`);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  };

  /** Follows the redirects of a GET by hand so the token never leaves googleapis.com. */
  const followRedirect = async (first: Response, authorization: string): Promise<Response> => {
    let res = first;
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop += 1) {
      const location = res.headers.get('location');
      if (location === null || location === '') return res;
      await discardBody(res);
      const next = new URL(location, 'https://www.googleapis.com/').toString();
      if (!next.startsWith('https://')) throw unexpected('Google Drive redirected the download to a non-https URL');
      res = await doFetch(next, {
        method: 'GET',
        headers: isGoogleApisUrl(next) ? { Authorization: authorization } : {},
        redirect: 'manual',
      });
    }
    return res;
  };

  /**
   * Sends one API request with: a single forced token refresh after a 401, retries (Retry-After or
   * exponential backoff) after 429 / 403 rate limits on any request and after 5xx / network
   * failures on idempotent requests. Resolves with a 2xx response (or `acceptAfterRetry`).
   */
  const send = async (spec: RequestSpec): Promise<Response> => {
    const url = buildUrl(spec);
    if (!isGoogleApisUrl(url)) throw unexpected('Refusing to send a token outside googleapis.com');
    const headers: Record<string, string> = { Accept: 'application/json', ...spec.headers };
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(spec.json);
    }

    let refreshed = false;
    let forceNext = false;
    let retries = 0;
    let mayHaveLanded = false;
    for (;;) {
      const authorization = `Bearer ${await token(forceNext)}`;
      forceNext = false;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: spec.method,
          headers: { ...headers, Authorization: authorization },
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
        });
        if (spec.follow === true && res.status >= 300 && res.status < 400) res = await followRedirect(res, authorization);
      } catch {
        const error = networkError();
        if (!spec.idempotent || retries >= MAX_REQUEST_RETRIES) throw error;
        mayHaveLanded = true;
        await sleep(backoff(retries, undefined));
        retries += 1;
        continue;
      }

      if (res.ok) return res;
      if (mayHaveLanded && spec.acceptAfterRetry !== undefined && res.status === spec.acceptAfterRetry) return res;

      const error = mapGoogleError(res.status, await readBody(res), res.headers);
      if (res.status === 401) {
        if (refreshed) throw error;
        refreshed = true;
        forceNext = true;
        continue;
      }
      const retryable =
        error.kind === 'rate_limit' || (error.kind === 'server' && spec.idempotent);
      if (retryable && retries < MAX_REQUEST_RETRIES) {
        if (error.kind === 'server') mayHaveLanded = true;
        await sleep(backoff(retries, error));
        retries += 1;
        continue;
      }
      if (res.status === PRESET_ID_CONFLICT_STATUS) {
        throw spec.presetId === true ? presetConflict(error) : withoutConflictStatus(error);
      }
      throw error;
    }
  };

  const sendJson = async (spec: RequestSpec): Promise<Record<string, unknown>> => {
    const res = await send(spec);
    const body = await readBody(res);
    if (!isRecord(body)) throw unexpected('Google Drive returned a malformed response');
    return body;
  };

  const toEntry = (raw: unknown): FileEntry => {
    const file = (isRecord(raw) ? raw : {}) as DriveFile;
    if (typeof file.id !== 'string' || file.id === '') throw unexpected('Google Drive returned a file without an id');
    const mimeType = typeof file.mimeType === 'string' && file.mimeType !== '' ? file.mimeType : 'application/octet-stream';
    const isFolder = mimeType === DRIVE_FOLDER_MIME_TYPE;
    const size = typeof file.size === 'string' && file.size !== '' ? Number(file.size) : null;
    const entry: FileEntry = {
      id: file.id,
      accountId,
      name: typeof file.name === 'string' ? file.name : '',
      mimeType,
      isFolder,
      sizeBytes: isFolder || size === null || !Number.isFinite(size) ? null : size,
      modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : new Date(0).toISOString(),
      parents: Array.isArray(file.parents) ? file.parents.filter((p): p is string => typeof p === 'string') : [],
      isGoogleNative: isGoogleNativeMimeType(mimeType),
      capabilities: {
        canCopy: file.capabilities?.canCopy === true,
        canTrash: file.capabilities?.canTrash === true,
        canDownload: file.capabilities?.canDownload === true,
      },
    };
    if (typeof file.md5Checksum === 'string' && file.md5Checksum !== '') entry.md5Checksum = file.md5Checksum;
    const targetId = file.shortcutDetails?.targetId;
    if (typeof targetId === 'string' && targetId !== '') entry.shortcutTargetId = targetId;
    return entry;
  };

  /**
   * files.get. A file in the trash is reported as 'not_found' (FileEntry has no trashed flag, and a
   * trashed copy must not count as present).
   */
  const fileGet = async (fileId: string): Promise<FileEntry> => {
    const body = await sendJson({
      method: 'GET',
      path: `/files/${encodeURIComponent(fileId)}`,
      query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
      idempotent: true,
    });
    if (body.trashed === true) {
      throw new ProviderError('Google Drive: the file is in the trash', {
        kind: 'not_found',
        retryable: false,
        status: 404,
        code: 'trashed',
      });
    }
    return toEntry(body);
  };

  /** The non-trashed file carrying the preset-id marker, optionally only inside `parentId`. */
  const findByMarker = async (presetId: string, parentId?: string): Promise<FileEntry | undefined> => {
    const clauses = [
      `appProperties has { key='${DRIVE_PRESET_ID_MARKER_KEY}' and value='${escapeQueryValue(presetId)}' }`,
      'trashed = false',
    ];
    if (parentId !== undefined) clauses.unshift(`'${escapeQueryValue(parentId)}' in parents`);
    const body = await sendJson({
      method: 'GET',
      path: '/files',
      query: {
        q: clauses.join(' and '),
        fields: `files(${DRIVE_FILE_FIELDS})`,
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      idempotent: true,
    });
    const first: unknown = Array.isArray(body.files) ? body.files[0] : undefined;
    return first === undefined ? undefined : toEntry(first);
  };

  const getFile = async (fileId: string): Promise<FileEntry> => {
    try {
      return await fileGet(fileId);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err;
      // A preset id realised through a marker (copy of a Google-native file).
      const marked = await findByMarker(fileId).catch(() => undefined);
      if (marked !== undefined) return marked;
      throw err;
    }
  };

  /** files.create / files.copy with a real preset id: a 409 after a retried attempt means it landed. */
  const createWithPresetId = async (spec: RequestSpec, presetId: string): Promise<FileEntry> => {
    const res = await send({ ...spec, idempotent: true, presetId: true, acceptAfterRetry: PRESET_ID_CONFLICT_STATUS });
    if (res.status === PRESET_ID_CONFLICT_STATUS) {
      await discardBody(res);
      return fileGet(presetId);
    }
    return toEntry(await readBody(res));
  };

  // -------------------------------------------------------------------------
  // Resumable upload
  // -------------------------------------------------------------------------

  const startUploadSession = async (params: ResumableUploadParams, knownSize: number | undefined): Promise<string> => {
    const mimeType = params.mimeType === '' ? 'application/octet-stream' : params.mimeType;
    const metadata: Record<string, unknown> = { name: params.name, mimeType, parents: [params.parentId] };
    if (params.presetId !== undefined) metadata.id = params.presetId;
    const headers: Record<string, string> = { 'X-Upload-Content-Type': mimeType };
    if (knownSize !== undefined) headers['X-Upload-Content-Length'] = String(knownSize);
    // Opening a session creates no file, so it is safe to repeat.
    const res = await send({
      method: 'POST',
      path: DRIVE_UPLOAD_URL,
      query: { uploadType: 'resumable', supportsAllDrives: true, fields: DRIVE_FILE_FIELDS },
      headers,
      json: metadata,
      idempotent: true,
      presetId: params.presetId !== undefined,
    });
    await discardBody(res);
    const location = res.headers.get('location');
    if (location === null || location === '') {
      throw new ProviderError('Google Drive did not return a resumable session URI', { kind: 'server', retryable: true });
    }
    // The session URI receives every chunk together with the bearer token: it must stay at Google.
    if (!isGoogleApisUrl(location)) {
      throw new ProviderError('Google Drive returned an unexpected resumable session URI', {
        kind: 'server',
        retryable: false,
      });
    }
    return location;
  };

  /**
   * Sends one chunk, resuming after interruptions (308 + Range, status query `bytes *\/total`).
   * Resolves with the file resource when Google reports the upload as complete, or `null` when it
   * stored the chunk and expects more.
   */
  const sendChunk = async (
    sessionUrl: string,
    chunk: Uint8Array,
    offset: number,
    total: number | undefined,
    isFinal: boolean,
    presetId: string | undefined,
  ): Promise<unknown> => {
    const end = offset + chunk.length;
    const totalText = total === undefined ? '*' : String(total);
    let start = offset;
    let failures = 0;
    let queryStatus = false;
    let refreshed = false;
    let forceNext = false;

    const failed = async (error: ProviderError): Promise<void> => {
      failures += 1;
      if (failures > MAX_CHUNK_RETRIES) throw error;
      await sleep(backoff(failures - 1, error));
      queryStatus = true; // ask Google how many bytes it has before sending anything again
    };

    for (;;) {
      const part = queryStatus ? EMPTY : chunk.subarray(start - offset);
      const contentRange = part.length === 0 ? `bytes */${totalText}` : `bytes ${start}-${end - 1}/${totalText}`;
      // Outside the try block: an auth failure must not be retried as if it were a network error.
      const authorization = `Bearer ${await token(forceNext)}`;
      forceNext = false;
      let res: Response;
      try {
        res = await doFetch(sessionUrl, {
          method: 'PUT',
          headers: { Authorization: authorization, 'Content-Range': contentRange },
          body: part.length === 0 ? new Uint8Array(0) : part,
          redirect: 'manual',
        });
      } catch {
        await failed(networkError());
        continue;
      }

      if (res.status === 200 || res.status === 201) return readBody(res);

      if (res.status === 308) {
        await discardBody(res);
        const confirmed = confirmedBytes(res.headers.get('range'));
        if (confirmed < start || confirmed > end) {
          throw new ProviderError(
            `Resumable upload out of sync: Google has ${confirmed} bytes, expected between ${start} and ${end}`,
            { kind: 'server', retryable: false },
          );
        }
        const progressed = confirmed > start;
        start = confirmed;
        if (start === end && !isFinal) return null;
        if (!progressed && !queryStatus) {
          await failed(new ProviderError('Resumable upload made no progress', { kind: 'server', retryable: false }));
          continue;
        }
        queryStatus = false;
        if (start === end && isFinal && chunk.length > 0) {
          await failed(
            new ProviderError('Resumable upload was not finalised by Google', { kind: 'server', retryable: false }),
          );
        }
        continue;
      }

      const body = await readBody(res);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        forceNext = true;
        continue;
      }
      if (res.status === 404) {
        // The session expired (one week of inactivity) or is unknown: the upload must start over.
        throw new ProviderError('The resumable upload session expired; the upload has to start again', {
          kind: 'server',
          retryable: true,
          code: 'upload_session_expired',
        });
      }
      const error = mapGoogleError(res.status, body, res.headers);
      if (res.status === PRESET_ID_CONFLICT_STATUS) {
        throw presetId === undefined ? withoutConflictStatus(error) : presetConflict(error);
      }
      if (error.retryable) {
        await failed(error);
        continue;
      }
      throw error;
    }
  };

  const resumableUploadFromStream = async (params: ResumableUploadParams): Promise<FileEntry> => {
    const chunkSize = normalizeChunkSize(params.chunkSize);
    const knownSize =
      typeof params.size === 'number' && Number.isFinite(params.size) && params.size >= 0 ? params.size : undefined;
    try {
      const sessionUrl = await startUploadSession(params, knownSize);
      const report = (bytesSent: number): void => {
        if (params.onProgress === undefined) return;
        params.onProgress(knownSize === undefined ? { bytesSent } : { bytesSent, bytesTotal: knownSize });
      };

      // One chunk of lookahead: a chunk is only sent as "not final" once more data is known to
      // follow, so the last request can always carry the real total (needed for unknown sizes).
      // At most one chunk is held while the next one is being read.
      let offset = 0;
      let pending: Uint8Array | null = null;
      for await (const chunk of fixedSizeChunks(params.stream, chunkSize)) {
        if (pending !== null) {
          const done = await sendChunk(sessionUrl, pending, offset, knownSize, false, params.presetId);
          if (done !== null) throw unexpected('Google Drive finished the upload before all data was sent');
          offset += pending.length;
          report(offset);
        }
        pending = chunk;
      }

      const last = pending ?? EMPTY;
      const total = offset + last.length;
      if (knownSize !== undefined && total !== knownSize) {
        throw unexpected(`Upload size mismatch: expected ${knownSize} bytes but the stream produced ${total}`);
      }
      const file = await sendChunk(sessionUrl, last, offset, total, true, params.presetId);
      if (!isRecord(file)) {
        throw new ProviderError('Google Drive did not confirm the completed upload', { kind: 'server', retryable: false });
      }
      report(total);
      if (typeof file.id === 'string' && (file.mimeType == null || file.modifiedTime == null)) {
        return await fileGet(file.id);
      }
      return toEntry(file);
    } catch (err) {
      params.stream.destroy();
      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // The provider
  // -------------------------------------------------------------------------

  const provider: CloudProvider = {
    id: 'google-drive' satisfies ProviderId,

    getAccountInfo: () =>
      guard(async (): Promise<ProviderAccountInfo> => {
        const body = await sendJson({
          method: 'GET',
          path: '/about',
          query: { fields: 'user(displayName,emailAddress,photoLink)' },
          idempotent: true,
        });
        const user = isRecord(body.user) ? body.user : {};
        const email = typeof user.emailAddress === 'string' ? user.emailAddress : '';
        const displayName = typeof user.displayName === 'string' && user.displayName !== '' ? user.displayName : email;
        const info: ProviderAccountInfo = { email, displayName };
        if (isHttpsUrl(user.photoLink)) info.avatarUrl = user.photoLink;
        return info;
      }),

    listFolder: (folderId, pageToken) =>
      guard(async (): Promise<FolderListing> => {
        const body = await sendJson({
          method: 'GET',
          path: '/files',
          query: {
            q: `'${escapeQueryValue(folderId)}' in parents and trashed = false`,
            fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
            // Server-side ordering so it stays correct across pages: folders first, then by name.
            orderBy: 'folder,name_natural',
            pageSize: LIST_PAGE_SIZE,
            spaces: 'drive',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            pageToken: pageToken === undefined || pageToken === '' ? undefined : pageToken,
          },
          idempotent: true,
        });
        const files: unknown[] = Array.isArray(body.files) ? body.files : [];
        const entries = files.map(toEntry);
        // Stable sort: guarantees folders first within the page, keeps Google's name order otherwise.
        entries.sort((a, b) => Number(b.isFolder) - Number(a.isFolder));
        const listing: FolderListing = { entries };
        if (typeof body.nextPageToken === 'string' && body.nextPageToken !== '') listing.nextPageToken = body.nextPageToken;
        return listing;
      }),

    getFile: (fileId) => guard(() => getFile(fileId)),

    getQuota: () =>
      guard(async (): Promise<Quota> => {
        const [body, byService] = await Promise.all([
          sendJson({ method: 'GET', path: '/about', query: { fields: 'storageQuota' }, idempotent: true }),
          // Only Drive v2 splits the usage per service (Drive / Gmail / Photos). Best effort: the
          // quota itself never fails because of it.
          sendJson({
            method: 'GET',
            path: DRIVE_V2_ABOUT_URL,
            query: { fields: 'quotaBytesByService' },
            idempotent: true,
          }).catch(() => null),
        ]);
        const raw = isRecord(body.storageQuota) ? body.storageQuota : {};
        const toNumber = (value: unknown): number | null => {
          if (typeof value !== 'string' || value === '') return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        // `limit` is absent for accounts with unlimited storage.
        const quota: Quota = { usedBytes: toNumber(raw.usage) ?? 0, totalBytes: toNumber(raw.limit) };
        const trash = toNumber(raw.usageInDriveTrash);
        if (trash !== null) quota.trashBytes = trash;
        const drive = toNumber(raw.usageInDrive);
        if (drive !== null) quota.driveBytes = drive;
        const services = byService !== null && Array.isArray(byService.quotaBytesByService) ? byService.quotaBytesByService : [];
        for (const service of services) {
          if (!isRecord(service)) continue;
          const bytes = toNumber(service.bytesUsed);
          if (bytes === null) continue;
          if (service.serviceName === 'DRIVE' && quota.driveBytes === undefined) quota.driveBytes = bytes;
          else if (service.serviceName === 'GMAIL') quota.gmailBytes = bytes;
          else if (service.serviceName === 'PHOTOS') quota.photosBytes = bytes;
        }
        return quota;
      }),

    generateIds: (count) =>
      guard(async (): Promise<string[]> => {
        if (!Number.isInteger(count) || count < 1) throw unexpected('generateIds needs a positive integer count');
        const ids: string[] = [];
        // Batches of at most 1000 (the documented maximum per call).
        while (ids.length < count) {
          const batch = Math.min(GENERATE_IDS_MAX, count - ids.length);
          const body = await sendJson({
            method: 'GET',
            path: '/files/generateIds',
            query: { count: batch, space: 'drive', type: 'files' },
            idempotent: true,
          });
          const got = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
          if (got.length === 0) throw unexpected('Google Drive returned no generated ids');
          ids.push(...got.slice(0, batch));
        }
        return ids;
      }),

    createFolder: (parentId, name, createOptions?: PresetIdOptions) =>
      guard(async (): Promise<FileEntry> => {
        const metadata: Record<string, unknown> = { name, mimeType: DRIVE_FOLDER_MIME_TYPE, parents: [parentId] };
        const spec: RequestSpec = {
          method: 'POST',
          path: '/files',
          query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
          json: metadata,
          idempotent: false,
        };
        const presetId = createOptions?.presetId;
        if (presetId === undefined) return toEntry(await sendJson(spec));
        metadata.id = presetId;
        return createWithPresetId(spec, presetId);
      }),

    downloadStream: (fileId) =>
      guard(async (): Promise<Readable> => {
        const file = await getFile(fileId);
        if (file.isFolder || file.isGoogleNative) {
          // Google Docs/Sheets/Slides have no binary content. They are never exported here.
          throw new ProviderError(`"${file.name}" (${file.mimeType}) has no binary content and cannot be streamed`, {
            kind: 'unknown',
            retryable: false,
            code: PROVIDER_ERROR_CODES.googleNativeNotStreamable,
          });
        }
        const res = await send({
          method: 'GET',
          path: `/files/${encodeURIComponent(file.id)}`,
          query: { alt: 'media', supportsAllDrives: true },
          idempotent: true,
          follow: true,
        });
        if (res.body === null) return Readable.from([]);
        return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      }),

    resumableUploadFromStream: (params) => guard(() => resumableUploadFromStream(params)),

    copyWithin: (fileId, destParentId, name, copyOptions?: PresetIdOptions) =>
      guard(async (): Promise<FileEntry> => {
        const source = await getFile(fileId);
        if (source.isFolder) {
          throw new ProviderError('Folders cannot be copied with files.copy', {
            kind: 'unknown',
            retryable: false,
            code: DRIVE_FOLDER_COPY_NOT_SUPPORTED,
          });
        }
        const presetId = copyOptions?.presetId;
        const metadata: Record<string, unknown> = { parents: [destParentId] };
        if (name !== undefined && name !== '') metadata.name = name;
        const spec: RequestSpec = {
          method: 'POST',
          path: `/files/${encodeURIComponent(source.id)}/copy`,
          query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
          json: metadata,
          idempotent: false,
        };

        if (presetId === undefined) {
          // Only Google-native files ever carry the marker: one copied along from the source would
          // make the copy answer for the source's preset id ("null values are cleared in copy requests").
          if (source.isGoogleNative) metadata.appProperties = { [DRIVE_PRESET_ID_MARKER_KEY]: null };
          return toEntry(await sendJson(spec));
        }
        if (!source.isGoogleNative) {
          metadata.id = presetId;
          return createWithPresetId(spec, presetId);
        }

        // Google-native source: the preset id is realised through the marker.
        const existing = await findByMarker(presetId, destParentId);
        if (existing !== undefined) return existing;
        metadata.appProperties = { [DRIVE_PRESET_ID_MARKER_KEY]: presetId };
        for (let attempt = 0; ; attempt += 1) {
          try {
            return toEntry(await sendJson(spec));
          } catch (err) {
            // The copy may have landed: look for the marker before trying again.
            if (!(err instanceof ProviderError) || err.kind !== 'server' || attempt >= MAX_REQUEST_RETRIES) throw err;
            await sleep(backoff(attempt, err));
            const landed = await findByMarker(presetId, destParentId);
            if (landed !== undefined) return landed;
          }
        }
      }),

    /** Moves the file to the Drive trash (recoverable): files.update { trashed: true }. */
    trash: (fileId) =>
      guard(async (): Promise<void> => {
        const res = await send({
          method: 'PATCH',
          path: `/files/${encodeURIComponent(fileId)}`,
          query: { fields: 'id,trashed', supportsAllDrives: true },
          json: { trashed: true },
          idempotent: true,
        });
        await discardBody(res);
      }),

    /**
     * files.delete, but only for a file that is in the trash right now: it is read first, and a file
     * that is not trashed (restored by the user) is refused. A 404 means it is already gone.
     */
    deleteTrashedForever: (fileId) =>
      guard(async (): Promise<void> => {
        let trashed: unknown;
        try {
          const body = await sendJson({
            method: 'GET',
            path: `/files/${encodeURIComponent(fileId)}`,
            query: { fields: 'id,trashed', supportsAllDrives: true },
            idempotent: true,
          });
          trashed = body.trashed;
        } catch (err) {
          if (err instanceof ProviderError && err.kind === 'not_found') return;
          throw err;
        }
        if (trashed !== true) {
          throw new ProviderError('Google Drive: the file is not in the trash; it is not deleted', {
            kind: 'unknown',
            retryable: false,
            code: PROVIDER_ERROR_CODES.notTrashed,
          });
        }
        const res = await send({
          method: 'DELETE',
          path: `/files/${encodeURIComponent(fileId)}`,
          query: { supportsAllDrives: true },
          idempotent: true,
          acceptAfterRetry: 404,
        });
        await discardBody(res);
      }),

    /** files.create of a shortcut. The preset id is realised through the marker (a Workspace type). */
    createShortcut: (parentId, name, targetId, shortcutOptions?: PresetIdOptions) =>
      guard(async (): Promise<FileEntry> => {
        const presetId = shortcutOptions?.presetId;
        const metadata: Record<string, unknown> = {
          name,
          mimeType: SHORTCUT_MIME_TYPE,
          parents: [parentId],
          shortcutDetails: { targetId },
        };
        const spec: RequestSpec = {
          method: 'POST',
          path: '/files',
          query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
          json: metadata,
          idempotent: false,
        };
        if (presetId === undefined) return toEntry(await sendJson(spec));
        const existing = await findByMarker(presetId, parentId);
        if (existing !== undefined) return existing;
        metadata.appProperties = { [DRIVE_PRESET_ID_MARKER_KEY]: presetId };
        for (let attempt = 0; ; attempt += 1) {
          try {
            return toEntry(await sendJson(spec));
          } catch (err) {
            if (!(err instanceof ProviderError) || err.kind !== 'server' || attempt >= MAX_REQUEST_RETRIES) throw err;
            await sleep(backoff(attempt, err));
            const landed = await findByMarker(presetId, parentId);
            if (landed !== undefined) return landed;
          }
        }
      }),

    shareWithAccount: (fileId, granteeEmail, shareOptions?: ShareOptions) =>
      guard(async (): Promise<{ permissionId: string; alreadyShared?: boolean }> => {
        // A user has one permission id per file, so creating a permission for someone who already
        // has access would hand back the owner's own share, and removing it "afterwards" would
        // revoke that share. Look first and leave an existing permission alone.
        const wanted = granteeEmail.trim().toLowerCase();
        let pageToken: string | undefined;
        do {
          const page = await sendJson({
            method: 'GET',
            path: `/files/${encodeURIComponent(fileId)}/permissions`,
            query: {
              fields: 'nextPageToken,permissions(id,type,emailAddress)',
              pageSize: 100,
              supportsAllDrives: true,
              pageToken,
            },
            idempotent: true,
          });
          const permissions: unknown[] = Array.isArray(page.permissions) ? page.permissions : [];
          for (const p of permissions) {
            if (
              isRecord(p) &&
              p.type === 'user' &&
              typeof p.id === 'string' &&
              p.id !== '' &&
              typeof p.emailAddress === 'string' &&
              p.emailAddress.toLowerCase() === wanted
            ) {
              return { permissionId: p.id, alreadyShared: true };
            }
          }
          pageToken = typeof page.nextPageToken === 'string' && page.nextPageToken !== '' ? page.nextPageToken : undefined;
        } while (pageToken !== undefined);

        // Repeating this create returns the same permission for the same user, so a retry after
        // a 5xx cannot create a second share.
        // The caller records its intent first: if this create lands but its response is lost, the
        // next listing finds the share and the mark tells the caller it is its own, not the owner's.
        shareOptions?.beforeCreate?.();
        const created = await sendJson({
          method: 'POST',
          path: `/files/${encodeURIComponent(fileId)}/permissions`,
          query: { fields: 'id', sendNotificationEmail: false, supportsAllDrives: true },
          json: { role: 'reader', type: 'user', emailAddress: granteeEmail },
          idempotent: true,
        });
        if (typeof created.id !== 'string' || created.id === '') throw unexpected('Google Drive did not return a permission id');
        return { permissionId: created.id };
      }),

    unshare: (fileId, permissionId) =>
      guard(async (): Promise<void> => {
        const res = await send({
          method: 'DELETE',
          path: `/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
          query: { supportsAllDrives: true },
          idempotent: true,
          acceptAfterRetry: 404,
        });
        await discardBody(res);
      }),
  };
  return provider;
}
