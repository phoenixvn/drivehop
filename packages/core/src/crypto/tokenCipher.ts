// Host-independent: WebCrypto (`crypto.subtle`, `crypto.getRandomValues`), `Uint8Array`,
// `TextEncoder` / `TextDecoder` only. No `node:` import, no `Buffer`, no `process`.

export const TOKEN_KEY_LENGTH = 32;
export const TOKEN_IV_LENGTH = 12;
export const TOKEN_TAG_LENGTH = 16;

/** Thrown (as a rejection) when a blob cannot be decrypted: wrong key, truncated or tampered data. */
export class DecryptionError extends Error {
  constructor(message = 'Unable to decrypt: wrong key or corrupted data') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * AES-256-GCM token cipher. Bytes in, bytes out, so both hosts store the same binary value
 * (Node: SQLite BLOB column `refresh_token_enc`; Worker: BLOB column of the Durable Object).
 *
 * BLOB FORMAT (byte-compatible with the former Node cipher apps/server/src/crypto/aesGcm.ts):
 *
 *     iv (12 random bytes) | auth tag (16 bytes) | ciphertext (UTF-8 of the plaintext)
 *
 * No additional authenticated data is used. Note that WebCrypto's AES-GCM `encrypt` returns
 * `ciphertext | tag` (tag LAST, tagLength 128) and `decrypt` expects that order, so the
 * implementation moves the tag: stored blob = iv | tag | ciphertext.
 */
export interface TokenCipher {
  /** Resolves with a fresh blob (new random IV on every call). */
  encrypt(plaintext: string): Promise<Uint8Array>;
  /**
   * Accepts any Uint8Array view, including a Node `Buffer` read from SQLite. Rejects with
   * DecryptionError when the blob is shorter than 28 bytes, was modified, or the key is wrong.
   */
  decrypt(blob: Uint8Array): Promise<string>;
}

const BASE64_TEXT = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Decodes standard or url-safe base64 (padding optional). Returns null when the text is not base64. */
function decodeBase64(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (trimmed === '' || !BASE64_TEXT.test(trimmed)) return null;
  let normalized = trimmed.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length % 4 === 1) return null;
  while (normalized.length % 4 !== 0) normalized += '=';
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A fresh copy backed by a plain ArrayBuffer (WebCrypto typings reject SharedArrayBuffer views). */
function copyBytes(source: Uint8Array, start = 0, end = source.length): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(end - start));
  out.set(source.subarray(start, end));
  return out;
}

/**
 * Imports the 32-byte master key once (non-extractable AES-GCM CryptoKey) and returns the cipher.
 * `masterKey` is the raw key, or its base64 / base64url text (surrounding whitespace ignored).
 * Rejects with a plain Error (whose message never contains key material) when the key is not
 * exactly 32 bytes or the text is not valid base64.
 */
export async function createTokenCipher(masterKey: Uint8Array | string): Promise<TokenCipher> {
  let raw: Uint8Array | null;
  if (typeof masterKey === 'string') {
    raw = decodeBase64(masterKey);
    if (raw === null) throw new Error('The master key is not valid base64');
  } else if (masterKey instanceof Uint8Array) {
    raw = masterKey;
  } else {
    throw new Error('The master key must be a Uint8Array or a base64 string');
  }
  if (raw.length !== TOKEN_KEY_LENGTH) {
    throw new Error(`The master key must be exactly ${TOKEN_KEY_LENGTH} bytes`);
  }
  const keyBytes = copyBytes(raw);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  keyBytes.fill(0);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

  return {
    async encrypt(plaintext: string): Promise<Uint8Array> {
      const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(TOKEN_IV_LENGTH)));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, tagLength: TOKEN_TAG_LENGTH * 8 },
          key,
          encoder.encode(plaintext),
        ),
      );
      // WebCrypto: ciphertext | tag  ->  stored: iv | tag | ciphertext
      const cipherLength = sealed.length - TOKEN_TAG_LENGTH;
      const blob = new Uint8Array(TOKEN_IV_LENGTH + sealed.length);
      blob.set(iv, 0);
      blob.set(sealed.subarray(cipherLength), TOKEN_IV_LENGTH);
      blob.set(sealed.subarray(0, cipherLength), TOKEN_IV_LENGTH + TOKEN_TAG_LENGTH);
      return blob;
    },

    async decrypt(blob: Uint8Array): Promise<string> {
      if (!(blob instanceof Uint8Array) || blob.length < TOKEN_IV_LENGTH + TOKEN_TAG_LENGTH) {
        throw new DecryptionError();
      }
      const iv = copyBytes(blob, 0, TOKEN_IV_LENGTH);
      const tag = blob.subarray(TOKEN_IV_LENGTH, TOKEN_IV_LENGTH + TOKEN_TAG_LENGTH);
      const ciphertext = blob.subarray(TOKEN_IV_LENGTH + TOKEN_TAG_LENGTH);
      const sealed = new Uint8Array(new ArrayBuffer(ciphertext.length + TOKEN_TAG_LENGTH));
      sealed.set(ciphertext, 0);
      sealed.set(tag, ciphertext.length);
      let plain: ArrayBuffer;
      try {
        plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: TOKEN_TAG_LENGTH * 8 }, key, sealed);
      } catch {
        throw new DecryptionError();
      }
      try {
        return decoder.decode(plain);
      } catch {
        throw new DecryptionError();
      }
    },
  };
}
