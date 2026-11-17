import type { Readable } from 'node:stream';
import type { FileEntry, FolderListing, ProviderId, Quota } from './domain.ts';

export interface ProviderAccountInfo {
  email: string;
  displayName: string;
  avatarUrl?: string;
}

export interface UploadProgress {
  bytesSent: number;
  /** Undefined when the total size is unknown. */
  bytesTotal?: number;
}

export interface ResumableUploadParams {
  parentId: string;
  name: string;
  mimeType: string;
  /** Total size in bytes when known; enables Content-Range totals and progress percentages. */
  size?: number;
  stream: Readable;
  /** Bytes per upload chunk. Providers pick a sensible default (Google: multiple of 256 KiB). */
  chunkSize?: number;
  onProgress?: (progress: UploadProgress) => void;
  /** Id the uploaded file must get; see PresetIdOptions. */
  presetId?: string;
}

/**
 * Idempotent creation. `presetId` is an id obtained from `generateIds` of the SAME (destination)
 * account; the caller persists it BEFORE the call. The contract, whatever the provider does inside:
 *
 * - Repeat calls: a repeat call with the same `presetId` never creates a second object. It either
 *   rejects with a ProviderError for which `isPresetIdConflict` is true (status 409, not
 *   retryable, nothing created) or resolves with the object that already exists.
 * - Destination id: the returned `FileEntry.id` is the id of the created object. Callers must not
 *   assume it equals `presetId` (a provider may have to realise the preset id through a marker).
 * - Resume recipe after an interruption: call `getFile(presetId)`. On 'not_found', repeat the
 *   create call with the same `presetId`. On a conflict from the create call, `getFile(presetId)`.
 *   `getFile(presetId)` must therefore resolve the object created for that preset id.
 *
 * No failure other than "this preset id is already in use" may have status 409.
 */
/** Options of `CloudProvider.shareWithAccount`. */
export interface ShareOptions {
  /**
   * Called synchronously after the provider found NO permission of the grantee on the file and
   * right before it sends the request that creates one (retries of that request follow it).
   * Not called when `alreadyShared` is returned without a create. A caller that persists a mark
   * here can tell later that a share found for the grantee came from its own create (e.g. after a
   * crash lost the response) and not from the owner. Must not throw.
   */
  beforeCreate?: () => void;
}

export interface PresetIdOptions {
  presetId?: string;
}

/** HTTP status of the ProviderError a provider rejects with when a `presetId` is already in use. */
export const PRESET_ID_CONFLICT_STATUS = 409;

/** MIME type of a Google Drive shortcut (a pointer to another file or folder, no content). */
export const SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';

/**
 * One instance is bound to one connected account. All methods are async and reject with
 * ProviderError. `trash` is the normal destructive operation. The ONLY permanent delete is
 * `deleteTrashedForever`, which refuses any file that is not already in the trash; the engine calls
 * it solely from the explicit, separately confirmed purge of a finished move job.
 */
export interface CloudProvider {
  readonly id: ProviderId;

  getAccountInfo(): Promise<ProviderAccountInfo>;
  /** `folderId` may be ROOT_FOLDER_ID ('root'). */
  listFolder(folderId: string, pageToken?: string): Promise<FolderListing>;
  getFile(fileId: string): Promise<FileEntry>;
  getQuota(): Promise<Quota>;
  createFolder(parentId: string, name: string, options?: PresetIdOptions): Promise<FileEntry>;

  /**
   * Reserves `count` (>= 1) unused file ids in this account, to be passed as `presetId` to
   * `createFolder`, `copyWithin` or `resumableUploadFromStream` of this same account.
   */
  generateIds(count: number): Promise<string[]>;

  /**
   * Binary content of a file. Rejects with ProviderError code 'google_native_not_streamable'
   * for Google Docs/Sheets/Slides, which have no binary content.
   */
  downloadStream(fileId: string): Promise<Readable>;
  resumableUploadFromStream(params: ResumableUploadParams): Promise<FileEntry>;

  /** Server-side copy of a file this account can read into a folder this account owns. */
  copyWithin(fileId: string, destParentId: string, name?: string, options?: PresetIdOptions): Promise<FileEntry>;
  /** Moves the file to the provider's trash (recoverable). */
  trash(fileId: string): Promise<void>;
  /**
   * PERMANENTLY deletes a file that is currently in the trash (frees its storage). Rejects with
   * ProviderError code 'not_trashed' (and deletes nothing) when the file is not in the trash, e.g.
   * because the user restored it. Resolves when the file is already gone.
   */
  deleteTrashedForever(fileId: string): Promise<void>;
  /**
   * Creates a shortcut named `name` in `parentId` pointing at `targetId` (a file or folder this
   * account can access). `options.presetId` makes the create idempotent like `copyWithin`.
   */
  createShortcut(parentId: string, name: string, targetId: string, options?: PresetIdOptions): Promise<FileEntry>;

  /**
   * Grants read access to another account WITHOUT sending a notification email.
   * If that account already has its own permission on the file (the owner shared it earlier),
   * nothing is created and `alreadyShared` is true: the caller must NOT `unshare` that
   * permission afterwards, or it would remove a share the owner made themselves.
   * `options.beforeCreate` (see ShareOptions) lets the caller record durably that it is about to
   * create a share, so a create whose response is lost is not mistaken for the owner's share later.
   */
  shareWithAccount(
    fileId: string,
    granteeEmail: string,
    options?: ShareOptions,
  ): Promise<{ permissionId: string; alreadyShared?: boolean }>;
  /** Removes a permission previously created by `shareWithAccount`. */
  unshare(fileId: string, permissionId: string): Promise<void>;
}

/** Resolves the provider instance for a locally stored account id. */
export type ProviderResolver = (accountId: string) => Promise<CloudProvider>;

export type ProviderErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'not_found'
  | 'forbidden'
  | 'server'
  | 'unknown';

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  retryable: boolean;
  /** HTTP status returned by the provider, when there was one. */
  status?: number;
  /** Machine-readable detail, e.g. 'google_native_not_streamable'. */
  code?: string;
  /** How long the provider asked the caller to wait before retrying (Retry-After), in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
}

/** Well-known values of `ProviderError.code`. */
export const PROVIDER_ERROR_CODES = {
  googleNativeNotStreamable: 'google_native_not_streamable',
  notTrashed: 'not_trashed',
} as const;

/** Runtime class (not just a type): thrown by providers, checked with `instanceof` by the engine. */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly kind: ProviderErrorKind;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/** True for the rejection of a create/copy/upload whose `presetId` already exists at the provider. */
export function isPresetIdConflict(value: unknown): boolean {
  return (
    value instanceof Error &&
    typeof (value as Partial<ProviderError>).kind === 'string' &&
    (value as Partial<ProviderError>).status === PRESET_ID_CONFLICT_STATUS
  );
}
