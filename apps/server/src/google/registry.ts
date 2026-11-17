import { createGoogleDriveProvider } from '@multicloud/core';
import { ProviderError } from '@multicloud/shared';
import type { CloudProvider, ProviderResolver } from '@multicloud/shared';
import type { TokenCipher } from '../crypto/tokenCipher.ts';
import type { AccountsRepo } from '../db/accounts.ts';
import { HttpError, notConfigured } from '../errors.ts';
import type { GoogleOAuth } from './oauth.ts';

export interface RegistryLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ProviderFactoryArgs {
  accountId: string;
  /** A valid access token, refreshed through the stored refresh token when needed. */
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  /** Marks the account as needing a reconnect and drops it from the cache. */
  onAuthError: () => void;
}

export interface ProviderResolverDeps {
  accounts: AccountsRepo;
  cipher: TokenCipher;
  /** `null` while GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing. */
  oauth: GoogleOAuth | null;
  /** Names of the missing environment variables, used in the 503 message. */
  missingConfig?: readonly string[];
  logger?: RegistryLogger;
  /** Override how a provider is built (tests). Default: the fetch-based Drive provider of @multicloud/core. */
  createProvider?: (args: ProviderFactoryArgs) => CloudProvider;
  /** Epoch milliseconds, for access-token expiry. Default `Date.now`. */
  now?: () => number;
}

export interface ProviderRegistry {
  /**
   * Builds (and caches per account) an authenticated provider from the decrypted refresh token.
   * Rejects with HttpError 503 `not_configured` when Google is not configured, and with
   * ProviderError kind 'not_found' (unknown account) or 'auth' (needs reconnect / no token).
   */
  resolveProvider: ProviderResolver;
  /** Synchronous. Throws when the account id is unknown. */
  getAccountEmail(accountId: string): string;
  /** Drops the cached provider, e.g. after a reconnect, a delete or an auth failure. */
  invalidate(accountId: string): void;
}

/** An access token is refreshed this long before Google says it expires. */
const ACCESS_TOKEN_SKEW_MS = 60_000;

function defaultCreateProvider(args: ProviderFactoryArgs): CloudProvider {
  return createGoogleDriveProvider(args);
}

export function createProviderResolver(deps: ProviderResolverDeps): ProviderRegistry {
  const { accounts, cipher, oauth, logger } = deps;
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Promise<CloudProvider>>();

  const invalidate = (accountId: string): void => {
    cache.delete(accountId);
  };

  const markNeedsReconnect = (accountId: string): void => {
    invalidate(accountId);
    if (!accounts.exists(accountId)) return;
    accounts.setStatus(accountId, 'needs_reconnect');
    logger?.warn(`account ${accountId} needs to be reconnected (Google rejected its credentials)`);
  };

  const needsReconnect = (message: string): ProviderError =>
    new ProviderError(message, { kind: 'auth', retryable: false });

  const build = async (accountId: string): Promise<CloudProvider> => {
    if (oauth === null) throw notConfigured(deps.missingConfig ?? []);

    const account = accounts.get(accountId);
    if (account === undefined) {
      throw new ProviderError(`Unknown account: ${accountId}`, { kind: 'not_found', retryable: false });
    }
    if (account.status !== 'connected') {
      throw needsReconnect(`Account ${account.email} needs to be reconnected`);
    }
    const encrypted = accounts.getRefreshTokenEnc(accountId);
    if (encrypted === null) {
      markNeedsReconnect(accountId);
      throw needsReconnect(`Account ${account.email} has no stored refresh token`);
    }
    let refreshToken: string;
    try {
      refreshToken = await cipher.decryptToken(encrypted);
    } catch {
      // Wrong / missing master key or corrupted data: the token is unusable until a reconnect.
      throw needsReconnect(`The stored token of account ${account.email} cannot be decrypted`);
    }

    let current: { accessToken: string; expiresAt: number } | null = null;
    let inFlight: Promise<string> | null = null;

    const refresh = async (): Promise<string> => {
      const token = await oauth.refreshAccessToken(refreshToken);
      current = { accessToken: token.accessToken, expiresAt: token.expiresAt };
      // Google may rotate the refresh token: persist the new one, re-encrypted.
      const rotated = token.refreshToken;
      if (rotated !== undefined && rotated !== '' && rotated !== refreshToken) {
        try {
          if (accounts.exists(accountId)) {
            accounts.setRefreshTokenEnc(accountId, await cipher.encryptToken(rotated));
            refreshToken = rotated;
            logger?.info(`stored a rotated refresh token for account ${accountId}`);
          }
        } catch {
          logger?.warn(`could not store the rotated refresh token of account ${accountId}`);
        }
      }
      return token.accessToken;
    };

    /** Cached access token; one refresh at a time; `forceRefresh` after a 401. */
    const getAccessToken = async (options?: { forceRefresh?: boolean }): Promise<string> => {
      if (options?.forceRefresh !== true && current !== null && current.expiresAt - ACCESS_TOKEN_SKEW_MS > now()) {
        return current.accessToken;
      }
      if (options?.forceRefresh === true) current = null;
      if (inFlight === null) {
        inFlight = refresh().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    };

    return createProvider({ accountId, getAccessToken, onAuthError: () => markNeedsReconnect(accountId) });
  };

  const resolveProvider: ProviderResolver = (accountId) => {
    const cached = cache.get(accountId);
    if (cached !== undefined) return cached;
    const pending = build(accountId).catch((err: unknown) => {
      if (cache.get(accountId) === pending) cache.delete(accountId);
      if (err instanceof ProviderError || err instanceof HttpError) throw err;
      throw new ProviderError('The Google Drive provider could not be created', { kind: 'unknown', retryable: false });
    });
    cache.set(accountId, pending);
    return pending;
  };

  const getAccountEmail = (accountId: string): string => {
    const account = accounts.get(accountId);
    if (account === undefined) throw new Error(`Unknown account: ${accountId}`);
    return account.email;
  };

  return { resolveProvider, getAccountEmail, invalidate };
}
