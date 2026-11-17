/** Identifier of a storage provider implementation. More providers will be added to this union. */
export type ProviderId = 'google-drive';

export const PROVIDER_IDS: readonly ProviderId[] = ['google-drive'];

/** `needs_reconnect` means the stored refresh token is missing, revoked or expired. */
export type AccountStatus = 'connected' | 'needs_reconnect';

export interface Account {
  /** Local id (primary key in the server database), not the provider's user id. */
  id: string;
  provider: ProviderId;
  email: string;
  displayName: string;
  avatarUrl?: string;
  status: AccountStatus;
}

export interface Quota {
  usedBytes: number;
  /** `null` means unlimited / not reported by the provider. */
  totalBytes: number | null;
  /** Bytes in Drive's trash (they still count toward the quota). */
  trashBytes?: number;
  /**
   * Bytes used by Drive files, trash included. The rest of `usedBytes` is Gmail and Google Photos:
   * Google only reports that remainder as one number.
   */
  driveBytes?: number;
  /** Bytes used by Gmail, when Google reports it per service. */
  gmailBytes?: number;
  /** Bytes used by Google Photos, when Google reports it per service. */
  photosBytes?: number;
}

/** An account plus its quota. `quota` is `null` when it has not been loaded or could not be fetched. */
export interface AccountWithQuota extends Account {
  quota: Quota | null;
}

export interface FileCapabilities {
  canCopy: boolean;
  canTrash: boolean;
  canDownload: boolean;
}

export interface FileEntry {
  /** Provider file id. */
  id: string;
  /** Local id of the account this entry was listed from. */
  accountId: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  /** `null` for folders and for files without binary content (e.g. Google Docs). */
  sizeBytes: number | null;
  /** ISO 8601 / RFC 3339 timestamp. */
  modifiedTime: string;
  md5Checksum?: string;
  parents: string[];
  /** True for Google Docs/Sheets/Slides etc.: no binary content, cannot be streamed as-is. */
  isGoogleNative: boolean;
  capabilities: FileCapabilities;
  /** Shortcuts only (`application/vnd.google-apps.shortcut`): id of the file or folder it points to. */
  shortcutTargetId?: string;
}

export interface FolderListing {
  entries: FileEntry[];
  nextPageToken?: string;
}

/** One segment of the path from the account root down to a folder. */
export interface Breadcrumb {
  id: string;
  name: string;
}

/** Alias accepted by providers and the HTTP API for the top-level folder of an account. */
export const ROOT_FOLDER_ID = 'root';
