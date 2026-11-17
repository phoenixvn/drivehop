import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PRESET_ID_CONFLICT_STATUS, PROVIDER_ERROR_CODES, ProviderError, ROOT_FOLDER_ID, SHORTCUT_MIME_TYPE } from '@multicloud/shared';
import type {
  CloudProvider,
  FileEntry,
  FolderListing,
  PresetIdOptions,
  ProviderAccountInfo,
  ProviderErrorKind,
  Quota,
  ResumableUploadParams,
  ShareOptions,
} from '@multicloud/shared';

/** In-memory stand-in for Google Drive, for tests only. No network, no timers besides setImmediate. */

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

export type FakeOp =
  | 'getAccountInfo'
  | 'listFolder'
  | 'getFile'
  | 'getQuota'
  | 'createFolder'
  | 'generateIds'
  | 'downloadStream'
  | 'resumableUploadFromStream'
  | 'copyWithin'
  | 'trash'
  | 'deleteTrashedForever'
  | 'createShortcut'
  | 'shareWithAccount'
  | 'unshare';

export interface FakeCall {
  seq: number;
  accountId: string;
  op: FakeOp;
  /** First argument of the call: the file / folder id (the parent id for createFolder and uploads). */
  target: string;
  /** Positional arguments. A trailing `{ presetId }` is present only when the caller passed a preset id. */
  args: unknown[];
}

export interface FakeNode {
  id: string;
  ownerAccountId: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  isGoogleNative: boolean;
  parentId: string | null;
  content: Buffer | null;
  trashed: boolean;
  canCopy: boolean;
  canDownload: boolean;
  /** permissionId -> grantee email */
  permissions: Map<string, string>;
  /** Shortcuts only: the node it points to. */
  shortcutTargetId?: string;
}

export interface FakeFileOptions {
  canCopy?: boolean;
  canDownload?: boolean;
  mimeType?: string;
}

export interface TreeSnapshot {
  name: string;
  children?: TreeSnapshot[];
  size?: number;
}

interface FailureRule {
  op: FakeOp;
  remaining: number;
  target?: string;
  makeError: () => unknown;
  /** True: the operation takes effect first, then the caller gets the error (a lost response). */
  afterSuccess?: boolean;
}

interface Gate {
  op: FakeOp;
  target?: string;
  open: boolean;
  waiters: Array<() => void>;
  arrivals: number;
  arrivalWaiters: Array<{ count: number; resolve: () => void }>;
}

export interface GateHandle {
  /** Lets every blocked (and every future) call through. */
  release(): void;
  /** Resolves once `count` calls are blocked at the gate. */
  waitForCalls(count?: number): Promise<void>;
}

export function fakeError(kind: ProviderErrorKind, status?: number, code?: string): ProviderError {
  const retryable = kind === 'rate_limit' || kind === 'server';
  return new ProviderError(`fake ${kind} error${status === undefined ? '' : ` (${status})`}`, {
    kind,
    retryable,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  });
}

/** The recorded arguments keep their old shape unless a preset id was passed. */
function withPreset(args: unknown[], presetId: string | undefined): unknown[] {
  return presetId === undefined ? args : [...args, { presetId }];
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function md5(content: Buffer): string {
  return createHash('md5').update(content).digest('hex');
}

/** The shared "cloud": all accounts, all nodes, one global call log. */
export class FakeDrive {
  readonly nodes = new Map<string, FakeNode>();
  readonly calls: FakeCall[] = [];
  readonly providers = new Map<string, FakeProvider>();
  /** Entries per listFolder page (small, so multi-page walks are exercised). */
  pageSize = 2;
  /** Size of the pieces a download stream emits. */
  downloadPieceBytes = 64 * 1024;
  inFlight = 0;
  maxInFlight = 0;
  private nextId = 1;
  private seq = 0;

  addAccount(accountId: string, email: string): FakeProvider {
    const provider = new FakeProvider(this, accountId, email);
    this.providers.set(accountId, provider);
    this.nodes.set(provider.rootId, {
      id: provider.rootId,
      ownerAccountId: accountId,
      name: 'My Drive',
      mimeType: FOLDER_MIME,
      isFolder: true,
      isGoogleNative: false,
      parentId: null,
      content: null,
      trashed: false,
      canCopy: false,
      canDownload: false,
      permissions: new Map(),
    });
    return provider;
  }

  provider(accountId: string): FakeProvider {
    const provider = this.providers.get(accountId);
    if (!provider) throw fakeError('auth', 401);
    return provider;
  }

  email(accountId: string): string {
    return this.provider(accountId).email;
  }

  newId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  record(accountId: string, op: FakeOp, args: unknown[]): FakeCall {
    const call: FakeCall = { seq: this.seq++, accountId, op, target: String(args[0] ?? ''), args };
    this.calls.push(call);
    return call;
  }

  /** Calls in order, optionally filtered by operation(s). */
  callsOf(...ops: FakeOp[]): FakeCall[] {
    return ops.length === 0 ? [...this.calls] : this.calls.filter((call) => ops.includes(call.op));
  }

  /** Compact call log, e.g. ['acc-a:shareWithAccount', 'acc-b:copyWithin', 'acc-a:unshare']. */
  sequence(...ops: FakeOp[]): string[] {
    return this.callsOf(...ops).map((call) => `${call.accountId}:${call.op}`);
  }

  /** Every permission that currently exists on any node, as 'nodeId:email'. */
  activePermissions(): string[] {
    const result: string[] = [];
    for (const node of this.nodes.values()) {
      for (const email of node.permissions.values()) result.push(`${node.id}:${email}`);
    }
    return result;
  }
}

export class FakeProvider implements CloudProvider {
  readonly id = 'google-drive' as const;
  readonly accountId: string;
  readonly email: string;
  readonly rootId: string;
  /** `chunkSize` of every upload, in call order. */
  readonly uploadChunkSizes: Array<number | undefined> = [];
  /** When set, uploads fail with this error after the given number of bytes was read. */
  failUploadAfter: { bytes: number; error: unknown; times: number } | undefined;
  /** When > 0, the next copies/uploads store altered content (same size, different checksum). */
  corruptNextWrites = 0;
  private readonly drive: FakeDrive;
  private readonly rules: FailureRule[] = [];
  private readonly gates: Gate[] = [];

  constructor(drive: FakeDrive, accountId: string, email: string) {
    this.drive = drive;
    this.accountId = accountId;
    this.email = email;
    this.rootId = `${accountId}-root`;
  }

  // ------------------------------------------------------------ test setup helpers

  addFolder(parentId: string, name: string): string {
    return this.insert(parentId, name, FOLDER_MIME, null, {}).id;
  }

  addFile(parentId: string, name: string, content: string | Buffer | number, options: FakeFileOptions = {}): string {
    const buffer =
      typeof content === 'number'
        ? Buffer.alloc(content, name.charCodeAt(0) || 1)
        : Buffer.isBuffer(content)
          ? content
          : Buffer.from(content);
    return this.insert(parentId, name, options.mimeType ?? 'application/octet-stream', buffer, options).id;
  }

  addGoogleDoc(parentId: string, name: string, options: FakeFileOptions = {}): string {
    return this.insert(parentId, name, options.mimeType ?? GOOGLE_DOC_MIME, null, options).id;
  }

  /** Makes the next `times` calls of `op` (optionally only for one target id) reject with `error`. */
  failNext(op: FakeOp, error: unknown | (() => unknown), times = 1, target?: string): void {
    const makeError = typeof error === 'function' ? (error as () => unknown) : () => error;
    this.rules.push({ op, remaining: times, makeError, ...(target === undefined ? {} : { target }) });
  }

  /**
   * Lost response: the next `times` SUCCESSFUL calls of `op` (optionally only for one target id) take
   * full effect at the fake Drive (the object is created, the share exists, ...) and then reject
   * with `error`, as if the network dropped the response. A call that fails on its own (e.g. a 409
   * for a used preset id) does not consume the rule. Default error: a retryable 503.
   */
  loseResponseNext(op: FakeOp, error: unknown | (() => unknown) = () => fakeError('server', 503), times = 1, target?: string): void {
    const makeError = typeof error === 'function' ? (error as () => unknown) : () => error;
    this.rules.push({ op, remaining: times, makeError, afterSuccess: true, ...(target === undefined ? {} : { target }) });
  }

  /** Blocks calls of `op` (optionally only for one target id) until the returned handle is released. */
  gate(op: FakeOp, target?: string): GateHandle {
    const gate: Gate = {
      op,
      open: false,
      waiters: [],
      arrivals: 0,
      arrivalWaiters: [],
      ...(target === undefined ? {} : { target }),
    };
    this.gates.push(gate);
    return {
      release: () => {
        gate.open = true;
        for (const resolve of gate.waiters.splice(0)) resolve();
      },
      waitForCalls: (count = 1) =>
        new Promise<void>((resolve) => {
          if (gate.arrivals >= count) resolve();
          else gate.arrivalWaiters.push({ count, resolve });
        }),
    };
  }

  node(id: string): FakeNode {
    const node = this.drive.nodes.get(this.resolveId(id));
    if (!node) throw new Error(`fake: no node ${id}`);
    return node;
  }

  /** Non-trashed children of a folder, by name. */
  childrenOf(folderId: string): FakeNode[] {
    const id = this.resolveId(folderId);
    return [...this.drive.nodes.values()]
      .filter((node) => node.parentId === id && !node.trashed)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** Name/size tree below a folder (children sorted by name), for structural assertions. */
  tree(folderId: string = ROOT_FOLDER_ID): TreeSnapshot[] {
    return this.childrenOf(folderId).map((node) =>
      node.isFolder
        ? { name: node.name, children: this.tree(node.id) }
        : { name: node.name, size: node.content?.length ?? 0 },
    );
  }

  // ------------------------------------------------------------ CloudProvider

  getAccountInfo(): Promise<ProviderAccountInfo> {
    return this.op('getAccountInfo', [], async () => ({ email: this.email, displayName: this.accountId }));
  }

  listFolder(folderId: string, pageToken?: string): Promise<FolderListing> {
    return this.op('listFolder', [folderId, pageToken], async () => {
      const folder = this.readable(folderId);
      if (!folder.isFolder) throw fakeError('not_found', 404);
      const all = [...this.drive.nodes.values()].filter((node) => node.parentId === folder.id && !node.trashed);
      const start = pageToken === undefined ? 0 : Number(pageToken);
      const page = all.slice(start, start + this.drive.pageSize);
      const next = start + this.drive.pageSize;
      return {
        entries: page.map((node) => this.entry(node)),
        ...(next < all.length ? { nextPageToken: String(next) } : {}),
      };
    });
  }

  getFile(fileId: string): Promise<FileEntry> {
    return this.op('getFile', [fileId], async () => this.entry(this.readable(fileId)));
  }

  getQuota(): Promise<Quota> {
    return this.op('getQuota', [], async () => ({ usedBytes: 0, totalBytes: null }));
  }

  createFolder(parentId: string, name: string, options?: PresetIdOptions): Promise<FileEntry> {
    return this.op('createFolder', withPreset([parentId, name], options?.presetId), async () => {
      const parent = this.owned(parentId);
      this.assertIdFree(options?.presetId);
      return this.entry(this.insert(parent.id, name, FOLDER_MIME, null, {}, options?.presetId));
    });
  }

  /** Ids no node has; like Drive, they are only reserved, nothing is created. */
  generateIds(count: number): Promise<string[]> {
    return this.op('generateIds', [count], async () => {
      if (!Number.isInteger(count) || count < 1) throw fakeError('unknown', 400);
      return Array.from({ length: count }, () => this.drive.newId(`${this.accountId}-gen`));
    });
  }

  downloadStream(fileId: string): Promise<Readable> {
    return this.op('downloadStream', [fileId], async () => {
      const node = this.readable(fileId);
      if (node.isGoogleNative || node.content === null) {
        throw fakeError('forbidden', 403, 'google_native_not_streamable');
      }
      if (!node.canDownload) throw fakeError('forbidden', 403);
      const content = node.content;
      const piece = this.drive.downloadPieceBytes;
      async function* pieces(): AsyncGenerator<Buffer> {
        for (let offset = 0; offset < content.length; offset += piece) {
          await tick();
          yield content.subarray(offset, offset + piece);
        }
      }
      return Readable.from(pieces(), { objectMode: false });
    });
  }

  resumableUploadFromStream(params: ResumableUploadParams): Promise<FileEntry> {
    const args = withPreset([params.parentId, params.name, params.chunkSize], params.presetId);
    return this.op('resumableUploadFromStream', args, async () => {
      const parent = this.owned(params.parentId);
      this.assertIdFree(params.presetId);
      this.uploadChunkSizes.push(params.chunkSize);
      const chunkSize = params.chunkSize ?? 256 * 1024;
      const chunks: Buffer[] = [];
      let received = 0;
      let reported = 0;
      for await (const chunk of params.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        chunks.push(buffer);
        received += buffer.length;
        const failure = this.failUploadAfter;
        if (failure && failure.times > 0 && received >= failure.bytes) {
          failure.times--;
          throw failure.error;
        }
        while (received - reported >= chunkSize) {
          reported += chunkSize;
          params.onProgress?.({
            bytesSent: reported,
            ...(params.size === undefined ? {} : { bytesTotal: params.size }),
          });
        }
      }
      params.onProgress?.({
        bytesSent: received,
        ...(params.size === undefined ? {} : { bytesTotal: params.size }),
      });
      const content = this.maybeCorrupt(Buffer.concat(chunks));
      // Checked again: another call may have used the id while the stream was being read.
      this.assertIdFree(params.presetId);
      return this.entry(this.insert(parent.id, params.name, params.mimeType, content, {}, params.presetId));
    });
  }

  copyWithin(fileId: string, destParentId: string, name?: string, options?: PresetIdOptions): Promise<FileEntry> {
    return this.op('copyWithin', withPreset([fileId, destParentId, name], options?.presetId), async () => {
      const source = this.readable(fileId);
      const parent = this.owned(destParentId);
      if (source.isFolder) throw fakeError('forbidden', 403);
      if (!source.canCopy) throw fakeError('forbidden', 403);
      this.assertIdFree(options?.presetId);
      const content = source.content === null ? null : this.maybeCorrupt(Buffer.from(source.content));
      const copy = this.insert(parent.id, name ?? source.name, source.mimeType, content, {}, options?.presetId);
      return this.entry(copy);
    });
  }

  trash(fileId: string): Promise<void> {
    return this.op('trash', [fileId], async () => {
      this.owned(fileId).trashed = true;
    });
  }

  deleteTrashedForever(fileId: string): Promise<void> {
    return this.op('deleteTrashedForever', [fileId], async () => {
      const node = this.drive.nodes.get(this.resolveId(fileId));
      if (!node) return;
      if (node.ownerAccountId !== this.accountId) throw fakeError('not_found', 404);
      if (!node.trashed) throw fakeError('unknown', undefined, PROVIDER_ERROR_CODES.notTrashed);
      // Like Drive: a folder takes its whole subtree with it.
      const doomed = new Set<string>([node.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const other of this.drive.nodes.values()) {
          if (other.parentId !== null && doomed.has(other.parentId) && !doomed.has(other.id)) {
            doomed.add(other.id);
            grew = true;
          }
        }
      }
      for (const id of doomed) this.drive.nodes.delete(id);
    });
  }

  createShortcut(parentId: string, name: string, targetId: string, options?: PresetIdOptions): Promise<FileEntry> {
    return this.op('createShortcut', withPreset([parentId, name, targetId], options?.presetId), async () => {
      const parent = this.owned(parentId);
      this.readable(targetId);
      this.assertIdFree(options?.presetId);
      const node = this.insert(parent.id, name, SHORTCUT_MIME_TYPE, null, {}, options?.presetId);
      node.shortcutTargetId = targetId;
      return this.entry(node);
    });
  }

  /** Test setup: a shortcut in `parentId` pointing at `targetId` (which may belong to anyone). */
  addShortcut(parentId: string, name: string, targetId: string): string {
    const node = this.insert(parentId, name, SHORTCUT_MIME_TYPE, null, {});
    node.shortcutTargetId = targetId;
    return node.id;
  }

  /** Test setup: grants this account's email read access to a node of any account. */
  grantRead(nodeId: string, email: string): void {
    const node = this.drive.nodes.get(this.resolveId(nodeId));
    if (!node) throw new Error(`no node ${nodeId}`);
    node.permissions.set(this.drive.newId('perm'), email);
  }

  /** Test setup: a share the owner made before any transfer (not recorded as a provider call). */
  preShare(fileId: string, granteeEmail: string): string {
    const permissionId = this.drive.newId('perm');
    this.owned(fileId).permissions.set(permissionId, granteeEmail);
    return permissionId;
  }

  shareWithAccount(
    fileId: string,
    granteeEmail: string,
    options?: ShareOptions,
  ): Promise<{ permissionId: string; alreadyShared?: boolean }> {
    return this.op('shareWithAccount', [fileId, granteeEmail], async () => {
      const node = this.owned(fileId);
      for (const [id, email] of node.permissions) {
        if (email === granteeEmail) return { permissionId: id, alreadyShared: true };
      }
      options?.beforeCreate?.();
      const permissionId = this.drive.newId('perm');
      node.permissions.set(permissionId, granteeEmail);
      return { permissionId };
    });
  }

  unshare(fileId: string, permissionId: string): Promise<void> {
    return this.op('unshare', [fileId, permissionId], async () => {
      const node = this.owned(fileId);
      if (!node.permissions.delete(permissionId)) throw fakeError('not_found', 404);
    });
  }

  // ------------------------------------------------------------ internals

  private async op<T>(op: FakeOp, args: unknown[], body: () => Promise<T>): Promise<T> {
    const call = this.drive.record(this.accountId, op, args);
    this.drive.inFlight++;
    this.drive.maxInFlight = Math.max(this.drive.maxInFlight, this.drive.inFlight);
    try {
      await tick();
      for (const gate of this.gates) {
        if (gate.op !== op || gate.open) continue;
        if (gate.target !== undefined && gate.target !== call.target) continue;
        gate.arrivals++;
        for (const waiter of gate.arrivalWaiters.filter((w) => gate.arrivals >= w.count)) {
          gate.arrivalWaiters.splice(gate.arrivalWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        await new Promise<void>((resolve) => gate.waiters.push(resolve));
      }
      const matches = (r: FailureRule): boolean =>
        r.op === op && r.remaining > 0 && (r.target === undefined || r.target === call.target);
      const rule = this.rules.find((r) => r.afterSuccess !== true && matches(r));
      if (rule) {
        rule.remaining--;
        throw rule.makeError();
      }
      const result = await body();
      const lost = this.rules.find((r) => r.afterSuccess === true && matches(r));
      if (lost) {
        lost.remaining--;
        throw lost.makeError();
      }
      return result;
    } finally {
      this.drive.inFlight--;
    }
  }

  private resolveId(id: string): string {
    return id === ROOT_FOLDER_ID ? this.rootId : id;
  }

  /** A node this account owns or was given a permission for (and that is not in the trash). */
  private readable(id: string): FakeNode {
    const node = this.drive.nodes.get(this.resolveId(id));
    if (!node || node.trashed) throw fakeError('not_found', 404);
    if (node.ownerAccountId === this.accountId) return node;
    if ([...node.permissions.values()].includes(this.email)) return node;
    throw fakeError('not_found', 404);
  }

  private owned(id: string): FakeNode {
    const node = this.drive.nodes.get(this.resolveId(id));
    if (!node || node.ownerAccountId !== this.accountId) throw fakeError('not_found', 404);
    return node;
  }

  private insert(
    parentId: string,
    name: string,
    mimeType: string,
    content: Buffer | null,
    options: FakeFileOptions,
    presetId?: string,
  ): FakeNode {
    const isFolder = mimeType === FOLDER_MIME;
    const isGoogleNative = !isFolder && mimeType.startsWith('application/vnd.google-apps.');
    const node: FakeNode = {
      id: presetId ?? this.drive.newId(this.accountId),
      ownerAccountId: this.accountId,
      name,
      mimeType,
      isFolder,
      isGoogleNative,
      parentId: this.resolveId(parentId),
      content: isFolder || isGoogleNative ? null : (content ?? Buffer.alloc(0)),
      trashed: false,
      canCopy: !isFolder && (options.canCopy ?? true),
      canDownload: !isFolder && !isGoogleNative && (options.canDownload ?? true),
      permissions: new Map(),
    };
    this.drive.nodes.set(node.id, node);
    return node;
  }

  /** Like Drive: an id that exists anywhere (any account, trashed or not) cannot be used again. */
  private assertIdFree(presetId: string | undefined): void {
    if (presetId !== undefined && this.drive.nodes.has(presetId)) {
      throw fakeError('unknown', PRESET_ID_CONFLICT_STATUS);
    }
  }

  private maybeCorrupt(content: Buffer): Buffer {
    if (this.corruptNextWrites <= 0 || content.length === 0) return content;
    this.corruptNextWrites--;
    const altered = Buffer.from(content);
    altered[0] = (altered[0] ?? 0) ^ 0xff;
    return altered;
  }

  private entry(node: FakeNode): FileEntry {
    return {
      id: node.id,
      accountId: this.accountId,
      name: node.name,
      mimeType: node.mimeType,
      isFolder: node.isFolder,
      sizeBytes: node.content === null ? null : node.content.length,
      modifiedTime: '2026-01-01T00:00:00.000Z',
      ...(node.content === null ? {} : { md5Checksum: md5(node.content) }),
      parents: node.parentId === null ? [] : [node.parentId],
      isGoogleNative: node.isGoogleNative,
      capabilities: { canCopy: node.canCopy, canTrash: true, canDownload: node.canDownload },
      ...(node.shortcutTargetId === undefined ? {} : { shortcutTargetId: node.shortcutTargetId }),
    };
  }
}
