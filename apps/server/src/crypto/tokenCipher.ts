import { createTokenCipher as createCoreTokenCipher } from '@multicloud/core';
import type { TokenCipher as CoreTokenCipher } from '@multicloud/core';
import type { KeySource } from './keySource.ts';

/**
 * Encrypts/decrypts refresh tokens with the master key (AES-256-GCM, WebCrypto implementation in
 * @multicloud/core; blob format iv | tag | ciphertext, unchanged). Never returns or stores plaintext.
 */
export interface TokenCipher {
  /** False when no master key can be obtained; `encryptToken` then rejects. */
  readonly available: boolean;
  /** Rejects with MasterKeyUnavailableError when there is no key. Resolves with a Buffer for SQLite. */
  encryptToken(token: string): Promise<Buffer>;
  /** Rejects with DecryptionError (wrong key / tampered) or MasterKeyUnavailableError. */
  decryptToken(blob: Uint8Array): Promise<string>;
}

/** The key source is lazy (the keyring entry is created on first use): import the key on first use. */
export function createTokenCipher(keySource: KeySource): TokenCipher {
  let cipher: Promise<CoreTokenCipher> | null = null;
  let cipherKey: Buffer | null = null;

  const getCipher = async (): Promise<CoreTokenCipher> => {
    const key = keySource.getKey(); // throws MasterKeyUnavailableError
    if (cipher === null || cipherKey !== key) {
      cipherKey = key;
      cipher = createCoreTokenCipher(new Uint8Array(key));
      cipher.catch(() => {
        cipher = null;
        cipherKey = null;
      });
    }
    return cipher;
  };

  return {
    get available(): boolean {
      return keySource.available;
    },
    async encryptToken(token: string): Promise<Buffer> {
      const blob = await (await getCipher()).encrypt(token);
      return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    },
    async decryptToken(blob: Uint8Array): Promise<string> {
      return (await getCipher()).decrypt(blob);
    },
  };
}
