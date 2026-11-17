import { randomBytes } from 'node:crypto';
import { TOKEN_KEY_LENGTH as KEY_LENGTH } from '@multicloud/core';

export const KEYRING_SERVICE = 'MultiCloud';
export const KEYRING_ACCOUNT = 'master-key';

/** Thrown when neither the OS credential store nor MULTICLOUD_MASTER_KEY can provide a key. */
export class MasterKeyUnavailableError extends Error {
  constructor() {
    super(
      'No master key available: the OS credential store cannot be used and MULTICLOUD_MASTER_KEY is not a base64 string of 32 bytes',
    );
    this.name = 'MasterKeyUnavailableError';
  }
}

/** Where the 32-byte master key comes from. Injectable so tests never touch the real keyring. */
export interface KeySource {
  /** True while the OS credential store is the working source of the key. */
  readonly keyringAvailable: boolean;
  /** True when `getKey()` can succeed (via the keyring or the environment fallback). */
  readonly available: boolean;
  /** Returns the 32-byte key. Throws MasterKeyUnavailableError when there is none. */
  getKey(): Buffer;
}

/** Minimal slice of `Entry` from @napi-rs/keyring (password stored as base64 text). */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
}

/** Decodes a base64 string and returns it only when it is exactly 32 bytes. */
export function decodeKey(base64: string | null | undefined): Buffer | null {
  if (typeof base64 !== 'string') return null;
  const trimmed = base64.trim();
  if (trimmed === '' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, 'base64');
  return key.length === KEY_LENGTH ? key : null;
}

/** A fixed key, for tests. */
export function createStaticKeySource(key: Buffer): KeySource {
  if (key.length !== KEY_LENGTH) throw new Error(`key must be ${KEY_LENGTH} bytes`);
  return { keyringAvailable: false, available: true, getKey: () => key };
}

export interface MasterKeySourceOptions {
  /** The OS keyring entry, or `null` when the native module could not be loaded. */
  keyring: KeyringEntry | null;
  /** Raw MULTICLOUD_MASTER_KEY (base64), used only when the keyring is unusable. */
  envKeyBase64?: string | null;
  /** Injectable for tests. Defaults to 32 random bytes from node:crypto. */
  generateKey?: () => Buffer;
}

/**
 * Master key lookup order:
 *  1. OS credential store. It is only READ when this function is called; a new random key is
 *     generated and stored on first use (`getKey()`), and only when the read succeeded and found
 *     nothing. An existing entry is never overwritten (that would orphan every stored token).
 *  2. MULTICLOUD_MASTER_KEY, when the keyring cannot be read/written or holds a malformed value.
 *  3. Otherwise `available` is false and `getKey()` throws: tokens are never stored in plaintext.
 */
export function createMasterKeySource(options: MasterKeySourceOptions): KeySource {
  const generateKey = options.generateKey ?? (() => randomBytes(KEY_LENGTH));
  const envKey = decodeKey(options.envKeyBase64);
  const keyring = options.keyring;

  let keyringOk = false;
  let cached: Buffer | null = null;

  if (keyring !== null) {
    try {
      const stored = keyring.getPassword();
      if (stored === null || stored === '') {
        keyringOk = true; // usable, key is created lazily on first use
      } else {
        const key = decodeKey(stored);
        if (key !== null) {
          cached = key;
          keyringOk = true;
        }
        // A malformed entry is left untouched and the environment fallback is used instead.
      }
    } catch {
      keyringOk = false;
    }
  }

  return {
    get keyringAvailable(): boolean {
      return keyringOk;
    },
    get available(): boolean {
      return keyringOk || envKey !== null;
    },
    getKey(): Buffer {
      if (cached !== null) return cached;
      if (keyringOk && keyring !== null) {
        try {
          const fresh = generateKey();
          if (fresh.length !== KEY_LENGTH) throw new Error('generated key has the wrong length');
          keyring.setPassword(fresh.toString('base64'));
          cached = fresh;
          return fresh;
        } catch {
          keyringOk = false;
        }
      }
      if (envKey !== null) {
        cached = envKey;
        return envKey;
      }
      throw new MasterKeyUnavailableError();
    },
  };
}
