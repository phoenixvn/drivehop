import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PRESET_ID_CONFLICT_STATUS, ProviderError, isPresetIdConflict } from '@multicloud/shared';
import { FakeDrive } from './testing/FakeProvider.ts';

function setup() {
  const drive = new FakeDrive();
  const a = drive.addAccount('acc-a', 'a@example.com');
  const b = drive.addAccount('acc-b', 'b@example.com');
  return { drive, a, b };
}

describe('FakeProvider preset ids', () => {
  it('generateIds returns unique unused ids and creates nothing', async () => {
    const { drive, a } = setup();
    const before = drive.nodes.size;
    const ids = [...(await a.generateIds(3)), ...(await a.generateIds(2))];
    expect(new Set(ids).size).toBe(5);
    expect(ids.some((id) => drive.nodes.has(id))).toBe(false);
    expect(drive.nodes.size).toBe(before);
    expect(drive.sequence('generateIds')).toEqual(['acc-a:generateIds', 'acc-a:generateIds']);
    await expect(a.generateIds(0)).rejects.toBeInstanceOf(ProviderError);
  });

  it('createFolder, copyWithin and resumableUploadFromStream give the object the preset id', async () => {
    const { a } = setup();
    const [folderId, copyId, uploadId] = await a.generateIds(3);
    const source = a.addFile('root', 'src.bin', 'hello');

    const folder = await a.createFolder('root', 'dir', { presetId: folderId! });
    const copy = await a.copyWithin(source, folder.id, 'copy.bin', { presetId: copyId! });
    const upload = await a.resumableUploadFromStream({
      parentId: folder.id,
      name: 'up.bin',
      mimeType: 'application/octet-stream',
      stream: Readable.from([Buffer.from('world')]),
      presetId: uploadId!,
    });

    expect([folder.id, copy.id, upload.id]).toEqual([folderId, copyId, uploadId]);
    expect((await a.getFile(copyId!)).name).toBe('copy.bin');
    expect(a.tree()).toEqual([
      { name: 'dir', children: [{ name: 'copy.bin', size: 5 }, { name: 'up.bin', size: 5 }] },
      { name: 'src.bin', size: 5 },
    ]);
  });

  it('rejects a preset id that already exists with a 409 conflict and creates nothing', async () => {
    const { drive, a } = setup();
    const [id] = await a.generateIds(1);
    const source = a.addFile('root', 'src.bin', 'hello');
    await a.copyWithin(source, 'root', 'first.bin', { presetId: id! });
    const before = drive.nodes.size;

    const attempts = [
      () => a.copyWithin(source, 'root', 'second.bin', { presetId: id! }),
      () => a.createFolder('root', 'dir', { presetId: id! }),
      () =>
        a.resumableUploadFromStream({
          parentId: 'root',
          name: 'up.bin',
          mimeType: 'application/octet-stream',
          stream: Readable.from([Buffer.from('x')]),
          presetId: id!,
        }),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(PRESET_ID_CONFLICT_STATUS);
      expect((error as ProviderError).retryable).toBe(false);
      expect(isPresetIdConflict(error)).toBe(true);
    }
    expect(drive.nodes.size).toBe(before);
    expect((await a.getFile(id!)).name).toBe('first.bin');
  });

  it('records a trailing { presetId } argument only when one was passed', async () => {
    const { drive, a } = setup();
    const [id] = await a.generateIds(1);
    await a.createFolder('root', 'plain');
    await a.createFolder('root', 'preset', { presetId: id! });
    expect(drive.callsOf('createFolder').map((call) => call.args)).toEqual([
      ['root', 'plain'],
      ['root', 'preset', { presetId: id }],
    ]);
  });

  it('isPresetIdConflict is false for other provider errors and for non-errors', () => {
    const notFound = new ProviderError('nope', { kind: 'not_found', retryable: false, status: 404 });
    expect(isPresetIdConflict(notFound)).toBe(false);
    expect(isPresetIdConflict(new Error('plain'))).toBe(false);
    expect(isPresetIdConflict(undefined)).toBe(false);
  });
});
