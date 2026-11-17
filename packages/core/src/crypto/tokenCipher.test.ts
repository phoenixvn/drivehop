// Uses node:crypto ONLY to reproduce the former Node cipher (apps/server/src/crypto/aesGcm.ts)
// and prove byte compatibility in both directions.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, TOKEN_IV_LENGTH, TOKEN_TAG_LENGTH, createTokenCipher } from './tokenCipher.ts';

/** Verbatim logic of the old `encrypt`: iv | tag | ciphertext. */
function legacyEncrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Verbatim logic of the old `decrypt`. */
function legacyDecrypt(key: Buffer, blob: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12), { authTagLength: 16 });
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}

const TOKEN = '1//0gRefresh-token_ví-dụ';

describe('WebCrypto token cipher', () => {
  const key = randomBytes(32);

  it('decrypts a blob written by the former Node cipher', async () => {
    const cipher = await createTokenCipher(new Uint8Array(key));
    const legacy = legacyEncrypt(key, TOKEN);
    expect(await cipher.decrypt(legacy)).toBe(TOKEN); // a Buffer, as better-sqlite3 returns it
    expect(await cipher.decrypt(new Uint8Array(legacy))).toBe(TOKEN);
  });

  it('writes blobs the former Node cipher can decrypt', async () => {
    const cipher = await createTokenCipher(key.toString('base64'));
    const blob = await cipher.encrypt(TOKEN);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(legacyDecrypt(key, Buffer.from(blob))).toBe(TOKEN);
  });

  it('has the layout iv | tag | ciphertext and never contains the plaintext', async () => {
    const cipher = await createTokenCipher(key);
    const blob = await cipher.encrypt('secret-token');
    expect(blob.length).toBe(TOKEN_IV_LENGTH + TOKEN_TAG_LENGTH + 'secret-token'.length);
    expect(Buffer.from(blob).includes(Buffer.from('secret-token'))).toBe(false);
    expect(await cipher.decrypt(await cipher.encrypt(''))).toBe('');
  });

  it('uses a fresh IV for every message', async () => {
    const cipher = await createTokenCipher(key);
    const a = await cipher.encrypt('same');
    const b = await cipher.encrypt('same');
    expect(Buffer.from(a.subarray(0, 12)).equals(Buffer.from(b.subarray(0, 12)))).toBe(false);
  });

  it('accepts base64url keys with surrounding whitespace', async () => {
    const cipher = await createTokenCipher(`  ${key.toString('base64url')}\n`);
    expect(await cipher.decrypt(legacyEncrypt(key, 'x'))).toBe('x');
  });

  it('rejects tampering, truncation and the wrong key with DecryptionError', async () => {
    const cipher = await createTokenCipher(key);
    const blob = await cipher.encrypt('do not touch');
    for (const index of [0, TOKEN_IV_LENGTH, TOKEN_IV_LENGTH + TOKEN_TAG_LENGTH, blob.length - 1]) {
      const tampered = new Uint8Array(blob);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      await expect(cipher.decrypt(tampered)).rejects.toBeInstanceOf(DecryptionError);
    }
    await expect(cipher.decrypt(blob.subarray(0, 27))).rejects.toBeInstanceOf(DecryptionError);
    await expect(cipher.decrypt(blob.subarray(0, blob.length - 1))).rejects.toBeInstanceOf(DecryptionError);
    const other = await createTokenCipher(randomBytes(32));
    await expect(other.decrypt(blob)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('rejects keys that are not 32 bytes or not base64, without echoing the key', async () => {
    await expect(createTokenCipher(randomBytes(16))).rejects.toThrow(/32 bytes/);
    await expect(createTokenCipher(randomBytes(33).toString('base64'))).rejects.toThrow(/32 bytes/);
    const bad = 'not base64 at all!';
    const error = await createTokenCipher(bad).catch((err: unknown) => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(bad);
    await expect(createTokenCipher('')).rejects.toThrow();
  });
});
