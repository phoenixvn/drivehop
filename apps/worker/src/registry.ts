// Builds an authenticated Google Drive provider per account (port of apps/server/src/google/registry.ts
// to the fetch-based core client, with async decryption and an access-token cache).
import { HttpError } from '@multicloud/core';
import type { GoogleDriveProviderOptions, GoogleOAuthClient, GoogleOAuthClientOptions, TokenCipher } from '@multicloud/core';
import { API_ERROR_CODES, ProviderError, isProviderError } from '@multicloud/shared';
import type { CloudProvider, ProviderResolver } from '@multicloud/shared';
import type { AccountsRepo } from './accounts.ts';

/** An access token is refreshed this long before Google says it expires. */
export const ACCESS_TOKEN_EARLY_REFRESH_MS = 60_000;

/**
 * Redirect URI handed to OAuth clients that only refresh or revoke tokens (those grants do not send
 * it). The interactive flow derives the real one from the request URL.
 */
export const NON_INTERACTIVE_REDIRECT_URI = 'https://localhost.invalid/api/auth/google/callback';

/** 503 `not_configured` with the Worker's wording (secrets instead of the Node host's .env). */
export function notConfigured(missing: readonly string[]): HttpError {
  const names = missing.length > 0 ? missing.join(', ') : 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET';
  return new HttpError(
    503,
    API_ERROR_CODES.notConfigured,
    `Worker chưa được cấu hình. Thiếu secret: ${names}. Hãy đặt bằng "wrangler secret put" rồi triển khai lại.`,
  );
}

/** 503 when MULTICLOUD_MASTER_KEY is missing or not 32 bytes: tokens are never stored unencrypted. */
export function tokenStorageUnavailable(): HttpError {
  return new HttpError(
    503,
    API_ERROR_CODES.notConfigured,
    'Không thể lưu token an toàn: secret MULTICLOUD_MASTER_KEY chưa được đặt hoặc không phải base64 của đúng 32 byte.',
  );
}

export interface RegistryLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface WorkerRegistryDeps {
  accounts: AccountsRepo;
  /** null while GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing. */
  oauthCredentials: () => { clientId: string; clientSecret: string } | null;
  missingConfig: () => string[];
  /** Rejects with tokenStorageUnavailable() when the master key is unusable. */
  getCipher: () => Promise<TokenCipher>;
  createOAuthClient: (options: GoogleOAuthClientOptions) => GoogleOAuthClient;
  createDriveProvider: (options: GoogleDriveProviderOptions) => CloudProvider;
  /** Counting fetch: every Google subrequest goes through it. */
  fetch: typeof fetch;
  now: () => number;
  logger: RegistryLogger;
}

export interface WorkerRegistry {
  resolveProvider: ProviderResolver;
  getAccountEmail(accountId: string): string;
  invalidate(accountId: string): void;
  /** OAuth client for refresh / revoke (never for the interactive flow). */
  nonInteractiveClient(): GoogleOAuthClient;
}

export function createWorkerRegistry(deps: WorkerRegistryDeps): WorkerRegistry {
  const { accounts, logger } = deps;
  const cache = new Map<string, CloudProvider>();

  const invalidate = (accountId: string): void => {
    cache.delete(accountId);
  };

  const markNeedsReconnect = (accountId: string): void => {
    invalidate(accountId);
    if (!accounts.exists(accountId)) return;
    accounts.setStatus(accountId, 'needs_reconnect');
    logger.warn(`account ${accountId} needs to be reconnected (Google rejected its credentials)`);
  };

  const needsReconnect = (message: string): ProviderError => new ProviderError(message, { kind: 'auth', retryable: false });

  const nonInteractiveClient = (): GoogleOAuthClient => {
    const credentials = deps.oauthCredentials();
    if (credentials === null) throw notConfigured(deps.missingConfig());
    return deps.createOAuthClient({
      ...credentials,
      redirectUri: NON_INTERACTIVE_REDIRECT_URI,
      fetch: deps.fetch,
      now: deps.now,
    });
  };

  const build = async (accountId: string): Promise<CloudProvider> => {
    if (deps.oauthCredentials() === null) throw notConfigured(deps.missingConfig());
    const account = accounts.get(accountId);
    if (account === undefined) {
      throw new ProviderError(`Unknown account: ${accountId}`, { kind: 'not_found', retryable: false });
    }
    if (account.status !== 'connected') throw needsReconnect(`Account ${account.email} needs to be reconnected`);
    const encrypted = accounts.getRefreshTokenEnc(accountId);
    if (encrypted === null) {
      markNeedsReconnect(accountId);
      throw needsReconnect(`Account ${account.email} has no stored refresh token`);
    }
    const cipher = await deps.getCipher();
    let refreshToken: string;
    try {
      refreshToken = await cipher.decrypt(encrypted);
    } catch {
      throw needsReconnect(`The stored token of account ${account.email} cannot be decrypted`);
    }

    const oauth = nonInteractiveClient();
    let cached: { token: string; expiresAt: number } | null = null;
    let refreshing: Promise<string> | null = null;

    const refresh = async (): Promise<string> => {
      try {
        const result = await oauth.refreshAccessToken(refreshToken);
        cached = { token: result.accessToken, expiresAt: result.expiresAt };
        const rotated = result.refreshToken;
        if (typeof rotated === 'string' && rotated !== '' && rotated !== refreshToken) {
          try {
            if (accounts.exists(accountId)) {
              accounts.setRefreshTokenEnc(accountId, await cipher.encrypt(rotated));
              refreshToken = rotated;
              logger.info(`stored a rotated refresh token for account ${accountId}`);
            }
          } catch {
            logger.warn(`could not store the rotated refresh token of account ${accountId}`);
          }
        }
        return result.accessToken;
      } catch (err) {
        if (isProviderError(err) && err.kind === 'auth') markNeedsReconnect(accountId);
        throw err;
      }
    };

    const getAccessToken = async (options?: { forceRefresh?: boolean }): Promise<string> => {
      const current = cached;
      if (options?.forceRefresh !== true && current !== null && current.expiresAt - ACCESS_TOKEN_EARLY_REFRESH_MS > deps.now()) {
        return current.token;
      }
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      return refreshing;
    };

    return deps.createDriveProvider({
      accountId,
      getAccessToken,
      onAuthError: () => markNeedsReconnect(accountId),
      fetch: deps.fetch,
      now: deps.now,
    });
  };

  const resolveProvider: ProviderResolver = async (accountId) => {
    const hit = cache.get(accountId);
    if (hit !== undefined) return hit;
    const provider = await build(accountId);
    cache.set(accountId, provider);
    return provider;
  };

  const getAccountEmail = (accountId: string): string => {
    const account = accounts.get(accountId);
    if (account === undefined) throw new Error(`Unknown account: ${accountId}`);
    return account.email;
  };

  return { resolveProvider, getAccountEmail, invalidate, nonInteractiveClient };
}
