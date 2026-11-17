import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError } from '@multicloud/core';
import {
  MasterKeyUnavailableError,
  createMasterKeySource,
  createStaticKeySource,
  decodeKey,
} from './keySource.ts';
import type { KeyringEntry } from './keySource.ts';
import { createTokenCipher } from './tokenCipher.ts';

function fakeKeyring(initial: string | null = null): KeyringEntry & { value: string | null; writes: number } {
  return {
    value: initial,
    writes: 0,
    getPassword() {
      return this.value;
    },
    setPassword(password: string) {
      this.value = password;
      this.writes += 1;
    },
  };
}

const brokenKeyring: KeyringEntry = {
  getPassword() {
    throw new Error('credential store locked');
  },
  setPassword() {
    throw new Error('credential store locked');
  },
};

describe('master key source', () => {
  it('only reads the keyring at creation and generates the key on first use', () => {
    const keyring = fakeKeyring();
    const source = createMasterKeySource({ keyring });
    expect(source.keyringAvailable).toBe(true);
    expect(source.available).toBe(true);
    expect(keyring.writes).toBe(0);

    const key = source.getKey();
    expect(key.length).toBe(32);
    expect(keyring.writes).toBe(1);
    expect(keyring.value).toBe(key.toString('base64'));
    expect(source.getKey().equals(key)).toBe(true);
    expect(keyring.writes).toBe(1);
  });

  it('reuses the key already stored in the keyring, ignoring the env key', () => {
    const stored = randomBytes(32);
    const keyring = fakeKeyring(stored.toString('base64'));
    const source = createMasterKeySource({ keyring, envKeyBase64: randomBytes(32).toString('base64') });
    expect(source.getKey().equals(stored)).toBe(true);
    expect(keyring.writes).toBe(0);
  });

  it('falls back to MULTICLOUD_MASTER_KEY when the keyring fails', () => {
    const envKey = randomBytes(32);
    for (const keyring of [brokenKeyring, null]) {
      const source = createMasterKeySource({ keyring, envKeyBase64: envKey.toString('base64') });
      expect(source.keyringAvailable).toBe(false);
      expect(source.available).toBe(true);
      expect(source.getKey().equals(envKey)).toBe(true);
    }
  });

  it('falls back to the env key when the first write to the keyring fails', () => {
    const envKey = randomBytes(32);
    const keyring: KeyringEntry = {
      getPassword: () => null,
      setPassword: () => {
        throw new Error('read-only store');
      },
    };
    const source = createMasterKeySource({ keyring, envKeyBase64: envKey.toString('base64') });
    expect(source.keyringAvailable).toBe(true);
    expect(source.getKey().equals(envKey)).toBe(true);
    expect(source.keyringAvailable).toBe(false);
  });

  it('never overwrites a malformed keyring entry', () => {
    const envKey = randomBytes(32);
    const keyring = fakeKeyring('not-a-32-byte-key');
    const source = createMasterKeySource({ keyring, envKeyBase64: envKey.toString('base64') });
    expect(source.keyringAvailable).toBe(false);
    expect(source.getKey().equals(envKey)).toBe(true);
    expect(keyring.value).toBe('not-a-32-byte-key');
    expect(keyring.writes).toBe(0);
  });

  it('refuses to provide a key when neither source works', () => {
    for (const envKeyBase64 of [null, '', 'c2hvcnQ=', 'not base64 at all!']) {
      const source = createMasterKeySource({ keyring: brokenKeyring, envKeyBase64 });
      expect(source.keyringAvailable).toBe(false);
      expect(source.available).toBe(false);
      expect(() => source.getKey()).toThrow(MasterKeyUnavailableError);
    }
  });

  it('decodeKey accepts only base64 of exactly 32 bytes', () => {
    expect(decodeKey(randomBytes(32).toString('base64'))?.length).toBe(32);
    expect(decodeKey(randomBytes(31).toString('base64'))).toBeNull();
    expect(decodeKey(randomBytes(33).toString('base64'))).toBeNull();
    expect(decodeKey(undefined)).toBeNull();
  });
});

describe('token cipher', () => {
  it('round-trips a refresh token with an injected key and returns a Buffer for SQLite', async () => {
    const cipher = createTokenCipher(createStaticKeySource(randomBytes(32)));
    const blob = await cipher.encryptToken('1//0abc-refresh');
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.length).toBe(12 + 16 + '1//0abc-refresh'.length);
    expect(blob.includes(Buffer.from('1//0abc-refresh'))).toBe(false);
    expect(await cipher.decryptToken(blob)).toBe('1//0abc-refresh');
  });

  it('rejects a blob encrypted with another key', async () => {
    const blob = await createTokenCipher(createStaticKeySource(randomBytes(32))).encryptToken('t');
    const other = createTokenCipher(createStaticKeySource(randomBytes(32)));
    await expect(other.decryptToken(blob)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses to encrypt without a master key instead of storing plaintext', async () => {
    const cipher = createTokenCipher(createMasterKeySource({ keyring: null }));
    expect(cipher.available).toBe(false);
    await expect(cipher.encryptToken('token')).rejects.toBeInstanceOf(MasterKeyUnavailableError);
  });

  it('uses the key the keyring creates on first use', async () => {
    const keyring = fakeKeyring();
    const cipher = createTokenCipher(createMasterKeySource({ keyring }));
    const blob = await cipher.encryptToken('t');
    expect(keyring.writes).toBe(1);
    expect(await cipher.decryptToken(blob)).toBe('t');
  });
});
