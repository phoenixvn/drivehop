import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ProviderError, isPresetIdConflict } from '@multicloud/shared';
import {
  DRIVE_FILE_FIELDS,
  DRIVE_FOLDER_COPY_NOT_SUPPORTED,
  DRIVE_FOLDER_MIME_TYPE,
  DRIVE_PRESET_ID_MARKER_KEY,
  DRIVE_UPLOAD_CHUNK_UNIT,
  createGoogleDriveProvider,
} from './drive.ts';
import type { Handler, RecordedRequest } from './testFetch.ts';
import { driveError, json, scriptedFetch } from './testFetch.ts';

const API = 'https://www.googleapis.com/drive/v3';
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION-CAPABILITY';

const file = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `${id}.bin`,
  mimeType: 'application/octet-stream',
  size: '12',
  modifiedTime: '2026-01-01T00:00:00.000Z',
  md5Checksum: 'abc',
  parents: ['root'],
  capabilities: { canCopy: true, canTrash: true, canDownload: true },
  ...extra,
});

function setup(fallback?: Handler) {
  const fake = scriptedFetch(fallback);
  const sleeps: number[] = [];
  const tokens: Array<boolean | undefined> = [];
  const onAuthError = vi.fn();
  let tokenValue = 'ya29.first';
  const provider = createGoogleDriveProvider({
    accountId: 'acc-1',
    getAccessToken: async (opts) => {
      tokens.push(opts?.forceRefresh);
      if (opts?.forceRefresh === true) tokenValue = 'ya29.refreshed';
      return tokenValue;
    },
    onAuthError,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { fake, provider, sleeps, tokens, onAuthError };
}

const path = (req: RecordedRequest | undefined) => `${req?.method} ${req?.url.pathname}`;
const bodyJson = (req: RecordedRequest | undefined) => JSON.parse(req?.body as string) as Record<string, unknown>;

describe('Google Drive provider: metadata', () => {
  it('getFile maps the resource and sends the bearer token', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('f1')));
    const entry = await provider.getFile('f1');
    expect(entry).toEqual({
      id: 'f1',
      accountId: 'acc-1',
      name: 'f1.bin',
      mimeType: 'application/octet-stream',
      isFolder: false,
      sizeBytes: 12,
      modifiedTime: '2026-01-01T00:00:00.000Z',
      md5Checksum: 'abc',
      parents: ['root'],
      isGoogleNative: false,
      capabilities: { canCopy: true, canTrash: true, canDownload: true },
    });
    const req = fake.calls[0];
    expect(`${req?.url.origin}${req?.url.pathname}`).toBe(`${API}/files/f1`);
    expect(req?.url.searchParams.get('fields')).toBe(DRIVE_FILE_FIELDS);
    expect(req?.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(req?.headers.get('authorization')).toBe('Bearer ya29.first');
    expect(req?.redirect).toBe('manual');
  });

  it('reports a trashed file as not_found', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('t', { trashed: true })));
    fake.once(() => json(200, { files: [] })); // marker fallback finds nothing (it excludes trashed files)
    await expect(provider.getFile('t')).rejects.toMatchObject({ kind: 'not_found', retryable: false });
    expect(fake.calls[1]?.url.searchParams.get('q')).toContain('trashed = false');
  });

  it('marks folders and Google-native files', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('d', { mimeType: DRIVE_FOLDER_MIME_TYPE, size: undefined })));
    fake.once(() => json(200, file('doc', { mimeType: 'application/vnd.google-apps.document', size: '1024' })));
    expect(await provider.getFile('d')).toMatchObject({ isFolder: true, isGoogleNative: false, sizeBytes: null });
    expect(await provider.getFile('doc')).toMatchObject({ isFolder: false, isGoogleNative: true, sizeBytes: 1024 });
  });

  it('listFolder queries the folder, paginates and puts folders first', async () => {
    const { fake, provider } = setup();
    fake.once(() =>
      json(200, { nextPageToken: 'next-1', files: [file('a'), file('dir', { mimeType: DRIVE_FOLDER_MIME_TYPE })] }),
    );
    fake.once(() => json(200, { files: [file('b')] }));
    const first = await provider.listFolder("it's");
    expect(first.entries.map((e) => e.id)).toEqual(['dir', 'a']);
    expect(first.nextPageToken).toBe('next-1');
    const q = fake.calls[0]?.url.searchParams;
    expect(q?.get('q')).toBe("'it\\'s' in parents and trashed = false");
    expect(q?.get('orderBy')).toBe('folder,name_natural');
    expect(q?.get('includeItemsFromAllDrives')).toBe('true');
    expect(q?.has('pageToken')).toBe(false);

    const second = await provider.listFolder('root', 'next-1');
    expect(second.nextPageToken).toBeUndefined();
    expect(fake.calls[1]?.url.searchParams.get('pageToken')).toBe('next-1');
  });

  it('getAccountInfo and getQuota read about.get', async () => {
    const { fake, provider } = setup();
    fake.once(() =>
      json(200, { user: { displayName: 'A', emailAddress: 'a@example.com', photoLink: 'https://lh3.googleusercontent.com/p' } }),
    );
    fake.once(() => json(200, { user: { emailAddress: 'a@example.com', photoLink: 'http://insecure' } }));
    expect(await provider.getAccountInfo()).toEqual({
      email: 'a@example.com',
      displayName: 'A',
      avatarUrl: 'https://lh3.googleusercontent.com/p',
    });
    expect(await provider.getAccountInfo()).toEqual({ email: 'a@example.com', displayName: 'a@example.com' });
    expect(path(fake.calls[0])).toBe('GET /drive/v3/about');
  });

  it('getQuota adds the per-service split from Drive v2 when available', async () => {
    const quotas = [
      { storageQuota: { limit: '1000', usage: '400', usageInDrive: '300', usageInDriveTrash: '10' } },
      { storageQuota: { limit: '1000', usage: '900', usageInDriveTrash: '0' } },
      { storageQuota: { usage: '5' } },
    ];
    const services = [
      json(200, { quotaBytesByService: [{ serviceName: 'DRIVE', bytesUsed: '290' }, { serviceName: 'GMAIL', bytesUsed: '60' }, { serviceName: 'PHOTOS', bytesUsed: '40' }] }),
      json(200, { quotaBytesByService: [{ serviceName: 'DRIVE', bytesUsed: '700' }, { serviceName: 'GMAIL', bytesUsed: '150' }, { serviceName: 'PHOTOS', bytesUsed: '50' }] }),
      driveError(403, 'insufficientPermissions'),
    ];
    const { fake, provider } = setup((req) =>
      req.url.pathname === '/drive/v2/about'
        ? (services.shift() ?? json(200, {}))
        : json(200, quotas.shift() ?? {}),
    );
    // v3 reports Drive usage: it wins over v2's DRIVE number.
    expect(await provider.getQuota()).toEqual({
      usedBytes: 400, totalBytes: 1000, trashBytes: 10, driveBytes: 300, gmailBytes: 60, photosBytes: 40,
    });
    // v3 leaves out usageInDrive (seen on real consumer accounts): v2 fills it in.
    expect(await provider.getQuota()).toEqual({
      usedBytes: 900, totalBytes: 1000, trashBytes: 0, driveBytes: 700, gmailBytes: 150, photosBytes: 50,
    });
    // The split failing never fails the quota.
    expect(await provider.getQuota()).toEqual({ usedBytes: 5, totalBytes: null });
    expect(fake.calls.find((c) => c.url.pathname === '/drive/v2/about')?.url.searchParams.get('fields')).toBe('quotaBytesByService');
  });

  it('generateIds batches by 1000', async () => {
    const { fake, provider } = setup((req) => {
      const count = Number(req.url.searchParams.get('count'));
      return json(200, { kind: 'drive#generatedIds', space: 'drive', ids: Array.from({ length: count }, (_, i) => `id${i}`) });
    });
    expect(await provider.generateIds(3)).toEqual(['id0', 'id1', 'id2']);
    const many = await provider.generateIds(1500);
    expect(many).toHaveLength(1500);
    expect(fake.calls.map((c) => c.url.searchParams.get('count'))).toEqual(['3', '1000', '500']);
    expect(fake.calls[0]?.url.searchParams.get('space')).toBe('drive');
    expect(fake.calls[0]?.url.searchParams.get('type')).toBe('files');
    await expect(provider.generateIds(0)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('Google Drive provider: errors and retries', () => {
  it('maps errors and never sends permanent deletes', async () => {
    const { fake, provider } = setup();
    fake.once(() => driveError(404, 'notFound', 'File not found: x'));
    fake.once(() => json(200, { files: [] })); // marker fallback lookup
    await expect(provider.getFile('x')).rejects.toMatchObject({ kind: 'not_found', status: 404, code: 'notFound' });
    fake.once(() => driveError(403, 'storageQuotaExceeded'));
    await expect(provider.createFolder('root', 'n')).rejects.toMatchObject({ kind: 'forbidden', code: 'storageQuotaExceeded' });
  });

  it('retries rate limits honouring Retry-After, then gives up', async () => {
    const { fake, provider, sleeps } = setup();
    fake.once(() => json(429, undefined, { 'Retry-After': '3' }));
    fake.once(() => driveError(403, 'userRateLimitExceeded'));
    fake.once(() => json(200, file('f')));
    expect((await provider.getFile('f')).id).toBe('f');
    expect(sleeps[0]).toBe(3000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(2000);

    const { fake: f2, provider: p2, sleeps: s2 } = setup(() => driveError(403, 'rateLimitExceeded'));
    await expect(p2.getFile('x')).rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(f2.calls).toHaveLength(4);
    expect(s2).toHaveLength(3);
  });

  it('retries 5xx and network failures only for idempotent requests', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(503, undefined));
    fake.once(() => {
      throw new TypeError('socket hang up');
    });
    fake.once(() => json(200, file('f')));
    expect((await provider.getFile('f')).id).toBe('f');
    expect(fake.calls).toHaveLength(3);

    const { fake: f2, provider: p2 } = setup();
    f2.once(() => json(500, undefined));
    await expect(p2.createFolder('root', 'x')).rejects.toMatchObject({ kind: 'server', retryable: true });
    expect(f2.calls).toHaveLength(1);
  });

  it('refreshes the token once after a 401 and reports a second 401', async () => {
    const { fake, provider, tokens, onAuthError } = setup();
    fake.once(() => driveError(401, 'authError', 'Invalid Credentials'));
    fake.once(() => json(200, file('f')));
    await provider.getFile('f');
    expect(tokens).toEqual([undefined, true]);
    expect(fake.calls[1]?.headers.get('authorization')).toBe('Bearer ya29.refreshed');
    expect(onAuthError).not.toHaveBeenCalled();

    fake.once(() => driveError(401, 'authError'));
    fake.once(() => driveError(401, 'authError'));
    await expect(provider.getFile('f')).rejects.toMatchObject({ kind: 'auth' });
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('forces exactly one token refresh after a 401, even when later retries follow', async () => {
    const { fake, provider, tokens } = setup();
    fake.once(() => driveError(401, 'authError'));
    fake.once(() => json(429, undefined));
    fake.once(() => json(200, file('f')));
    await provider.getFile('f');
    expect(tokens).toEqual([undefined, true, undefined]);
  });

  it('an empty access token is an auth error', async () => {
    const onAuthError = vi.fn();
    const fake = scriptedFetch();
    const provider = createGoogleDriveProvider({ accountId: 'a', getAccessToken: async () => '', onAuthError, fetch: fake.fetch });
    await expect(provider.getFile('f')).rejects.toMatchObject({ kind: 'auth' });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(0);
  });

  it('a plain token failure is not an auth error', async () => {
    const onAuthError = vi.fn();
    const provider = createGoogleDriveProvider({
      accountId: 'a',
      getAccessToken: async () => {
        throw new Error('disk on fire');
      },
      onAuthError,
      fetch: scriptedFetch().fetch,
    });
    const error = (await provider.getFile('f').catch((err: unknown) => err)) as Error;
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'unknown' });
    expect(error.message).not.toContain('disk on fire');
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('reports token failures as auth errors', async () => {
    const onAuthError = vi.fn();
    const fake = scriptedFetch();
    const provider = createGoogleDriveProvider({
      accountId: 'a',
      getAccessToken: async () => {
        throw new ProviderError('Google Drive 400 invalid_grant: revoked', { kind: 'auth', retryable: false, status: 400 });
      },
      onAuthError: () => {
        onAuthError();
        throw new Error('must not mask');
      },
      fetch: fake.fetch,
    });
    await expect(provider.getQuota()).rejects.toMatchObject({ kind: 'auth' });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(0);
  });

  it('a 409 without a preset id never carries status 409', async () => {
    const { fake, provider } = setup();
    fake.once(() => driveError(409, 'conflict'));
    const error = await provider.createFolder('root', 'x').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(isPresetIdConflict(error)).toBe(false);
  });
});

describe('Google Drive provider: create and copy', () => {
  it('createFolder without and with a preset id', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('new', { mimeType: DRIVE_FOLDER_MIME_TYPE })));
    expect((await provider.createFolder('p', 'Docs')).isFolder).toBe(true);
    expect(bodyJson(fake.calls[0])).toEqual({ name: 'Docs', mimeType: DRIVE_FOLDER_MIME_TYPE, parents: ['p'] });

    fake.once(() => json(200, file('preset-1', { mimeType: DRIVE_FOLDER_MIME_TYPE })));
    expect((await provider.createFolder('p', 'Docs', { presetId: 'preset-1' })).id).toBe('preset-1');
    expect(bodyJson(fake.calls[1])).toMatchObject({ id: 'preset-1' });

    // Resume recipe: getFile(presetId) finds the object right after the create.
    fake.once(() => json(200, file('preset-1', { mimeType: DRIVE_FOLDER_MIME_TYPE })));
    expect((await provider.getFile('preset-1')).id).toBe('preset-1');
  });

  it('a preset id already in use rejects with a 409 conflict', async () => {
    const { fake, provider } = setup();
    fake.once(() => driveError(409, 'fileIdInUse', 'A file already exists with the provided ID.'));
    const error = await provider.createFolder('p', 'Docs', { presetId: 'used' }).catch((err: unknown) => err);
    expect(isPresetIdConflict(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, retryable: false });
  });

  it('a 409 after a retried preset-id create returns the file the first attempt created', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(503, undefined));
    fake.once(() => driveError(409, 'conflict'));
    fake.once(() => json(200, file('preset-2', { mimeType: DRIVE_FOLDER_MIME_TYPE })));
    expect((await provider.createFolder('p', 'Docs', { presetId: 'preset-2' })).id).toBe('preset-2');
    expect(fake.calls.map(path)).toEqual(['POST /drive/v3/files', 'POST /drive/v3/files', 'GET /drive/v3/files/preset-2']);
  });

  it('copyWithin copies a binary file with the preset id', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('src')));
    fake.once(() => json(200, file('preset-3')));
    const copy = await provider.copyWithin('src', 'dest', 'Copy.bin', { presetId: 'preset-3' });
    expect(copy.id).toBe('preset-3');
    expect(path(fake.calls[1])).toBe('POST /drive/v3/files/src/copy');
    expect(bodyJson(fake.calls[1])).toEqual({
      parents: ['dest'],
      name: 'Copy.bin',
      id: 'preset-3',
    });
    expect(fake.calls[1]?.url.searchParams.get('supportsAllDrives')).toBe('true');
  });

  it('copyWithin without a preset id', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('src')));
    fake.once(() => json(200, file('copy')));
    expect((await provider.copyWithin('src', 'dest')).id).toBe('copy');
    expect(bodyJson(fake.calls[1])).toEqual({ parents: ['dest'] });

    // A Google-native source may carry a marker from an earlier copy: it is cleared on the copy.
    fake.once(() => json(200, file('doc', { mimeType: 'application/vnd.google-apps.document' })));
    fake.once(() => json(200, file('copy2', { mimeType: 'application/vnd.google-apps.document' })));
    await provider.copyWithin('doc', 'dest');
    expect(bodyJson(fake.calls[3])).toEqual({ parents: ['dest'], appProperties: { [DRIVE_PRESET_ID_MARKER_KEY]: null } });
  });

  it('copyWithin never copies folders', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('dir', { mimeType: DRIVE_FOLDER_MIME_TYPE })));
    await expect(provider.copyWithin('dir', 'dest')).rejects.toMatchObject({ code: DRIVE_FOLDER_COPY_NOT_SUPPORTED });
    expect(fake.calls).toHaveLength(1);
  });

  it('copyWithin of a Google-native file realises the preset id through the marker', async () => {
    const { fake, provider } = setup();
    const doc = { mimeType: 'application/vnd.google-apps.document', size: undefined };
    fake.once(() => json(200, file('doc', doc)));
    fake.once(() => json(200, { files: [] })); // marker lookup in the destination
    fake.once(() => json(200, file('drive-assigned', doc)));
    const copy = await provider.copyWithin('doc', 'dest', undefined, { presetId: 'preset-4' });
    expect(copy.id).toBe('drive-assigned');
    const q = fake.calls[1]?.url.searchParams.get('q');
    expect(q).toBe(
      `'dest' in parents and appProperties has { key='${DRIVE_PRESET_ID_MARKER_KEY}' and value='preset-4' } and trashed = false`,
    );
    const body = bodyJson(fake.calls[2]);
    expect(body).toEqual({ parents: ['dest'], appProperties: { [DRIVE_PRESET_ID_MARKER_KEY]: 'preset-4' } });
    expect(body.id).toBeUndefined();

    // Repeat call: the marked copy exists, nothing new is created.
    fake.once(() => json(200, file('doc', doc)));
    fake.once(() => json(200, { files: [file('drive-assigned', doc)] }));
    expect((await provider.copyWithin('doc', 'dest', undefined, { presetId: 'preset-4' })).id).toBe('drive-assigned');
    expect(fake.calls).toHaveLength(5);

    // getFile(presetId) resolves the marked copy.
    fake.once(() => driveError(404, 'notFound'));
    fake.once(() => json(200, { files: [file('drive-assigned', doc)] }));
    expect((await provider.getFile('preset-4')).id).toBe('drive-assigned');
    expect(fake.calls[6]?.url.searchParams.get('q')).toBe(
      `appProperties has { key='${DRIVE_PRESET_ID_MARKER_KEY}' and value='preset-4' } and trashed = false`,
    );
  });

  it('a failed Google-native marker copy checks the marker before trying again', async () => {
    const { fake, provider } = setup();
    const doc = { mimeType: 'application/vnd.google-apps.spreadsheet', size: undefined };
    fake.once(() => json(200, file('doc', doc)));
    fake.once(() => json(200, { files: [] }));
    fake.once(() => json(502, undefined));
    fake.once(() => json(200, { files: [file('landed', doc)] }));
    expect((await provider.copyWithin('doc', 'dest', 'Sheet', { presetId: 'p5' })).id).toBe('landed');
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('Google Drive provider: trash and sharing', () => {
  it('trash is files.update { trashed: true }', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, { id: 'f', trashed: true }));
    await provider.trash('f');
    expect(path(fake.calls[0])).toBe('PATCH /drive/v3/files/f');
    expect(bodyJson(fake.calls[0])).toEqual({ trashed: true });
  });

  it('shareWithAccount creates a reader permission without notification email', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, { nextPageToken: 'p2', permissions: [{ id: 'owner', type: 'user', emailAddress: 'owner@x.com' }] }));
    fake.once(() => json(200, { permissions: [{ id: 'anyone', type: 'anyone' }] }));
    fake.once(() => json(200, { id: 'perm-1' }));
    expect(await provider.shareWithAccount('f', 'Dest@Example.com')).toEqual({ permissionId: 'perm-1' });
    expect(fake.calls[1]?.url.searchParams.get('pageToken')).toBe('p2');
    const create = fake.calls[2];
    expect(path(create)).toBe('POST /drive/v3/files/f/permissions');
    expect(create?.url.searchParams.get('sendNotificationEmail')).toBe('false');
    expect(bodyJson(create)).toEqual({ role: 'reader', type: 'user', emailAddress: 'Dest@Example.com' });
  });

  it('shareWithAccount reuses an existing user permission and creates nothing', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, { permissions: [{ id: 'existing', type: 'user', emailAddress: 'dest@example.com' }] }));
    expect(await provider.shareWithAccount('f', ' DEST@example.com ')).toEqual({ permissionId: 'existing', alreadyShared: true });
    expect(fake.calls).toHaveLength(1);
  });

  it('shareWithAccount calls beforeCreate after the lookup found nothing and before the create is sent', async () => {
    const { fake, provider } = setup();
    let callsWhenHooked = -1;
    fake.once(() => json(200, { permissions: [] }));
    fake.once(() => json(200, { id: 'perm-1' }));
    await provider.shareWithAccount('f', 'dest@example.com', { beforeCreate: () => (callsWhenHooked = fake.calls.length) });
    expect(callsWhenHooked).toBe(1);
    expect(path(fake.calls[1])).toBe('POST /drive/v3/files/f/permissions');

    let hooked = false;
    fake.once(() => json(200, { permissions: [{ id: 'existing', type: 'user', emailAddress: 'dest@example.com' }] }));
    await provider.shareWithAccount('f', 'dest@example.com', { beforeCreate: () => (hooked = true) });
    expect(hooked).toBe(false);
  });

  it('unshare deletes the permission; a 404 after a retried delete counts as done', async () => {
    const { fake, provider } = setup();
    fake.once(() => new Response(null, { status: 204 }));
    await provider.unshare('f', 'perm-1');
    expect(path(fake.calls[0])).toBe('DELETE /drive/v3/files/f/permissions/perm-1');

    fake.once(() => json(500, undefined));
    fake.once(() => driveError(404, 'notFound'));
    await provider.unshare('f', 'perm-1');

    fake.once(() => driveError(404, 'notFound'));
    await expect(provider.unshare('f', 'perm-x')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('Google Drive provider: download', () => {
  it('streams binary content', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('f')));
    fake.once(() => new Response('hello world!', { status: 200 }));
    const stream = await provider.downloadStream('f');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('hello world!');
    expect(fake.calls[1]?.url.searchParams.get('alt')).toBe('media');
  });

  it('follows a media redirect, sending the token only to googleapis.com', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('f')));
    fake.once(() => new Response(null, { status: 302, headers: { Location: 'https://content.googleusercontent.com/x' } }));
    fake.once(() => new Response('data', { status: 200 }));
    const stream = await provider.downloadStream('f');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('data');
    expect(fake.calls[1]?.redirect).toBe('manual');
    expect(fake.calls[2]?.url.hostname).toBe('content.googleusercontent.com');
    expect(fake.calls[2]?.headers.has('authorization')).toBe(false);
  });

  it('refuses to stream folders', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('dir', { mimeType: DRIVE_FOLDER_MIME_TYPE })));
    await expect(provider.downloadStream('dir')).rejects.toMatchObject({ code: 'google_native_not_streamable' });
    expect(fake.calls).toHaveLength(1);
  });

  it('never exports Google-native files', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, file('doc', { mimeType: 'application/vnd.google-apps.document' })));
    await expect(provider.downloadStream('doc')).rejects.toMatchObject({ code: 'google_native_not_streamable' });
    expect(fake.calls).toHaveLength(1);
  });
});

describe('Google Drive provider: resumable upload', () => {
  const sessionStart = (): Response => new Response(null, { status: 200, headers: { Location: SESSION } });

  function bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) out[i] = i % 251;
    return out;
  }

  it('uploads in 256 KiB multiples with Content-Range and returns the file', async () => {
    const { fake, provider } = setup();
    const data = bytes(DRIVE_UPLOAD_CHUNK_UNIT * 2 + 10);
    fake.once(sessionStart);
    fake.once(() => new Response(null, { status: 308, headers: { Range: `bytes=0-${DRIVE_UPLOAD_CHUNK_UNIT - 1}` } }));
    fake.once(() => new Response(null, { status: 308, headers: { Range: `bytes=0-${2 * DRIVE_UPLOAD_CHUNK_UNIT - 1}` } }));
    fake.once(() => json(200, file('up', { size: String(data.length) })));
    const progress: number[] = [];
    const entry = await provider.resumableUploadFromStream({
      parentId: 'p',
      name: 'a.bin',
      mimeType: 'application/octet-stream',
      size: data.length,
      stream: Readable.from([Buffer.from(data.subarray(0, 1000)), Buffer.from(data.subarray(1000))]),
      chunkSize: DRIVE_UPLOAD_CHUNK_UNIT,
      onProgress: (p) => progress.push(p.bytesSent),
      presetId: 'preset-up',
    });
    expect(entry.id).toBe('up');
    const start = fake.calls[0];
    expect(`${start?.url.origin}${start?.url.pathname}`).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(start?.url.searchParams.get('uploadType')).toBe('resumable');
    expect(start?.headers.get('x-upload-content-length')).toBe(String(data.length));
    expect(bodyJson(start)).toEqual({ name: 'a.bin', mimeType: 'application/octet-stream', parents: ['p'], id: 'preset-up' });
    const ranges = fake.calls.slice(1).map((c) => c.headers.get('content-range'));
    const u = DRIVE_UPLOAD_CHUNK_UNIT;
    expect(ranges).toEqual([
      `bytes 0-${u - 1}/${data.length}`,
      `bytes ${u}-${2 * u - 1}/${data.length}`,
      `bytes ${2 * u}-${data.length - 1}/${data.length}`,
    ]);
    const sent = Buffer.concat(fake.calls.slice(1).map((c) => Buffer.from(c.body as Uint8Array)));
    expect(sent.equals(Buffer.from(data))).toBe(true);
    expect(progress).toEqual([u, 2 * u, data.length]);
    expect(fake.calls.slice(1).every((c) => c.url.toString() === SESSION && c.redirect === 'manual')).toBe(true);
  });

  it('resumes after a 5xx by querying the status and sending only the missing bytes', async () => {
    const { fake, provider, sleeps } = setup();
    const u = DRIVE_UPLOAD_CHUNK_UNIT;
    const data = bytes(u + 100);
    fake.once(sessionStart);
    fake.once(() => json(503, undefined)); // first chunk fails
    fake.once(() => new Response(null, { status: 308, headers: { Range: 'bytes=0-999' } })); // status query
    fake.once(() => new Response(null, { status: 308, headers: { Range: `bytes=0-${u - 1}` } })); // rest of chunk 1
    fake.once(() => {
      throw new TypeError('connection reset'); // final chunk: network failure
    });
    fake.once(() => new Response(null, { status: 308, headers: { Range: `bytes=0-${u + 49}` } })); // status query
    fake.once(() => json(201, file('done', { size: String(data.length) })));
    const entry = await provider.resumableUploadFromStream({
      parentId: 'p',
      name: 'a.bin',
      mimeType: '',
      stream: Readable.from([Buffer.from(data)]),
      chunkSize: u,
    });
    expect(entry.id).toBe('done');
    const ranges = fake.calls.slice(1).map((c) => c.headers.get('content-range'));
    expect(ranges).toEqual([
      `bytes 0-${u - 1}/*`,
      'bytes */*',
      `bytes 1000-${u - 1}/*`,
      `bytes ${u}-${u + 99}/${u + 100}`,
      `bytes */${u + 100}`,
      `bytes ${u + 50}-${u + 99}/${u + 100}`,
    ]);
    expect((fake.calls[3]?.body as Uint8Array).length).toBe(u - 1000);
    expect(sleeps).toHaveLength(2);
    expect(bodyJson(fake.calls[0]).mimeType).toBe('application/octet-stream');
  });

  it('repeats a chunk with a refreshed token after a 401', async () => {
    const { fake, provider, tokens } = setup();
    fake.once(sessionStart);
    fake.once(() => driveError(401, 'authError'));
    fake.once(() => json(200, file('done', { size: '3' })));
    await provider.resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', size: 3, stream: Readable.from([Buffer.from('abc')]) });
    expect(tokens).toEqual([undefined, undefined, true]);
    expect(Buffer.from(fake.calls[2]?.body as Uint8Array).toString()).toBe('abc');
    expect(fake.calls[2]?.headers.get('authorization')).toBe('Bearer ya29.refreshed');
  });

  it('refuses a session URI outside googleapis.com', async () => {
    const { fake, provider } = setup();
    fake.once(() => new Response(null, { status: 200, headers: { Location: 'https://evil.example/upload' } }));
    const stream = Readable.from([Buffer.from('abc')]);
    await expect(
      provider.resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', stream }),
    ).rejects.toThrow(/unexpected resumable session URI/);
    expect(fake.calls).toHaveLength(1);
    expect(stream.destroyed).toBe(true);
  });

  it('an expired session and a used preset id', async () => {
    const { fake, provider } = setup();
    fake.once(sessionStart);
    fake.once(() => driveError(404, 'notFound'));
    const error = await provider
      .resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', stream: Readable.from([Buffer.from('a')]) })
      .catch((err: unknown) => err as ProviderError);
    expect(error).toMatchObject({ kind: 'server', retryable: true, code: 'upload_session_expired' });
    expect((error as Error).message).not.toContain('SESSION-CAPABILITY');

    fake.once(() => driveError(409, 'conflict'));
    const conflict = await provider
      .resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', stream: Readable.from([Buffer.from('a')]), presetId: 'used' })
      .catch((err: unknown) => err);
    expect(isPresetIdConflict(conflict)).toBe(true);
  });

  it('uploads an empty file with bytes */0', async () => {
    const { fake, provider } = setup();
    fake.once(sessionStart);
    fake.once(() => json(200, file('empty', { size: '0' })));
    const entry = await provider.resumableUploadFromStream({ parentId: 'p', name: 'e', mimeType: 'text/plain', size: 0, stream: Readable.from([]) });
    expect(entry.sizeBytes).toBe(0);
    expect(fake.calls[1]?.headers.get('content-range')).toBe('bytes */0');
  });

  it('retries a rate-limited chunk and gives up after the retry limit', async () => {
    const { fake, provider } = setup();
    fake.once(sessionStart);
    fake.once(() => json(429, undefined, { 'Retry-After': '1' }));
    fake.once(() => new Response(null, { status: 308 })); // status query: nothing stored yet
    fake.once(() => json(200, file('ok', { size: '3' })));
    expect((await provider.resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', size: 3, stream: Readable.from([Buffer.from('abc')]) })).id).toBe('ok');
    expect(fake.calls.slice(1).map((c) => c.headers.get('content-range'))).toEqual(['bytes 0-2/3', 'bytes */3', 'bytes 0-2/3']);

    const { fake: f2, provider: p2, sleeps } = setup();
    f2.once(sessionStart);
    for (let i = 0; i < 6; i += 1) f2.once(() => json(503, undefined));
    await expect(
      p2.resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', size: 3, stream: Readable.from([Buffer.from('abc')]) }),
    ).rejects.toMatchObject({ kind: 'server', retryable: true });
    expect(sleeps).toHaveLength(5);
  });

  it('stops when the stored range is out of sync', async () => {
    const { fake, provider } = setup();
    const u = DRIVE_UPLOAD_CHUNK_UNIT;
    fake.once(sessionStart);
    fake.once(() => new Response(null, { status: 308, headers: { Range: `bytes=0-${2 * u}` } }));
    await expect(
      provider.resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', stream: Readable.from([Buffer.from(bytes(u + 1))]), chunkSize: u }),
    ).rejects.toThrow(/out of sync/);
  });

  it('fetches the full metadata when the final response is partial', async () => {
    const { fake, provider } = setup();
    fake.once(sessionStart);
    fake.once(() => json(200, { id: 'partial' }));
    fake.once(() => json(200, file('partial', { size: '3' })));
    const entry = await provider.resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', size: 3, stream: Readable.from([Buffer.from('abc')]) });
    expect(entry).toMatchObject({ id: 'partial', sizeBytes: 3 });
    expect(path(fake.calls[2])).toBe('GET /drive/v3/files/partial');
  });

  it('rejects a size mismatch', async () => {
    const { fake, provider } = setup();
    fake.once(sessionStart);
    await expect(
      provider.resumableUploadFromStream({ parentId: 'p', name: 'x', mimeType: 'text/plain', size: 10, stream: Readable.from([Buffer.from('abc')]) }),
    ).rejects.toThrow(/size mismatch/);
  });
});

describe('Google Drive provider: shortcuts and permanent delete', () => {
  it('maps the shortcut target and creates a shortcut with the preset-id marker', async () => {
    const { fake, provider } = setup();
    const shortcut = { mimeType: 'application/vnd.google-apps.shortcut', size: undefined, md5Checksum: undefined };
    fake.once(() => json(200, file('s', { ...shortcut, shortcutDetails: { targetId: 'target-1' } })));
    expect((await provider.getFile('s')).shortcutTargetId).toBe('target-1');

    fake.once(() => json(200, { files: [] })); // no earlier attempt landed
    fake.once(() => json(200, file('new', { ...shortcut, shortcutDetails: { targetId: 'copy-1' } })));
    const created = await provider.createShortcut('dest-folder', 'report.iso', 'copy-1', { presetId: 'p-1' });
    expect(created).toMatchObject({ id: 'new', shortcutTargetId: 'copy-1', isGoogleNative: true });
    expect(path(fake.calls[2])).toBe('POST /drive/v3/files');
    expect(bodyJson(fake.calls[2])).toEqual({
      name: 'report.iso',
      mimeType: 'application/vnd.google-apps.shortcut',
      parents: ['dest-folder'],
      shortcutDetails: { targetId: 'copy-1' },
      appProperties: { [DRIVE_PRESET_ID_MARKER_KEY]: 'p-1' },
    });
  });

  it('deletes forever only a file that is in the trash', async () => {
    const { fake, provider } = setup();
    fake.once(() => json(200, { id: 't', trashed: true }));
    fake.once(() => new Response(null, { status: 204 }));
    await provider.deleteTrashedForever('t');
    expect(fake.calls.map(path)).toEqual(['GET /drive/v3/files/t', 'DELETE /drive/v3/files/t']);

    fake.once(() => json(200, { id: 'r', trashed: false }));
    await expect(provider.deleteTrashedForever('r')).rejects.toMatchObject({ code: 'not_trashed' });
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);

    fake.once(() => driveError(404, 'notFound'));
    await expect(provider.deleteTrashedForever('gone')).resolves.toBeUndefined();
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
