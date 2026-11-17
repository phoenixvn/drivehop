import { KEYRING_ACCOUNT, KEYRING_SERVICE } from './keySource.ts';
import type { KeyringEntry } from './keySource.ts';

/**
 * Opens the MultiCloud entry of the OS credential store (Windows Credential Manager).
 * This is the only module that imports @napi-rs/keyring. Returns `null` instead of throwing when
 * the native module cannot be loaded, so the server still boots and falls back to
 * MULTICLOUD_MASTER_KEY.
 */
export async function loadOsKeyringEntry(): Promise<KeyringEntry | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const entry = new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
    return {
      getPassword: () => entry.getPassword(),
      setPassword: (password: string) => entry.setPassword(password),
    };
  } catch {
    return null;
  }
}
