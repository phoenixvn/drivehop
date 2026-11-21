import type { ProviderResolver } from '@multicloud/shared';
import type { AppConfig, ConfigStatus } from '../config.ts';
import type { TokenCipher } from '../crypto/tokenCipher.ts';
import type { AccountsRepo } from '../db/accounts.ts';
import { notFound } from '../errors.ts';
import type { GoogleOAuth, OAuthStateStore } from '../google/oauth.ts';

/** Everything the route plugins need; passed as the plugin options. */
export interface RouteDeps {
  config: AppConfig;
  getStatus: () => ConfigStatus;
  accounts: AccountsRepo;
  cipher: TokenCipher;
  /** `null` while the Google OAuth client is not configured. */
  oauth: GoogleOAuth | null;
  stateStore: OAuthStateStore;
  resolveProvider: ProviderResolver;
  /** Drops the cached provider of an account. */
  invalidateProvider: (accountId: string) => void;
}

// The schemas are host-independent and live in @multicloud/core (shared with the Worker).
export {
  ACCOUNT_ID_PATTERN,
  FILE_ID_PATTERN,
  MAX_PAGE_TOKEN_LENGTH,
  accountIdSchema,
  fileIdSchema,
  pageTokenSchema,
  parseOrBadRequest,
} from '@multicloud/core';

/** Throws 404 `not_found` unless `accountId` belongs to a stored account. */
export function requireAccount(accounts: AccountsRepo, accountId: string): void {
  if (!accounts.exists(accountId)) throw notFound('Account not found (it may have been removed).');
}
