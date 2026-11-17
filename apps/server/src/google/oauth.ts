import { randomBytes } from 'node:crypto';
import { createGoogleOAuthClient } from '@multicloud/core';
import type { GoogleAccessToken, GoogleOAuthClient, GoogleProfile } from '@multicloud/core';

// The OAuth client itself is host-independent and lives in @multicloud/core (plain fetch, no
// google-auth-library). This module adapts it to the names the Node routes use and keeps the
// Node-specific CSRF state store.
export { GOOGLE_SCOPES, isHttpsUrl } from '@multicloud/core';
export type { GoogleAccessToken, GoogleProfile } from '@multicloud/core';

export interface ExchangeResult {
  /** `null` when Google did not return a refresh token (it only does on first consent). */
  refreshToken: string | null;
  /** Taken from the id_token of the token response (iss, aud, exp and email_verified checked). */
  profile: GoogleProfile;
  /**
   * `false` when Google reported the granted scopes and the Drive scope is not among them
   * (the consent screen lets the user untick it). Absent or `true` otherwise.
   */
  driveScopeGranted?: boolean;
}

/**
 * Everything the server needs from Google's OAuth endpoints. Routes and the provider registry
 * depend on this interface so tests can inject a fake and run without any network access.
 */
export interface GoogleOAuth {
  /** URL of the consent screen for the given CSRF `state`. */
  generateAuthUrl(state: string): string;
  /** Exchanges the authorization code and verifies the id_token. */
  exchangeCode(code: string): Promise<ExchangeResult>;
  /** Revokes a refresh token at Google. Does not touch any Drive data. */
  revokeToken(token: string): Promise<void>;
  /** refresh_token grant: a short-lived access token (and a rotated refresh token, if any). */
  refreshAccessToken(refreshToken: string): Promise<GoogleAccessToken>;
}

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** http://localhost:<PORT>/api/auth/google/callback */
  redirectUri: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** OAuth for a "Web application" client. Uses access_type=offline and prompt=consent. */
export function createGoogleOAuth(options: GoogleOAuthOptions): GoogleOAuth {
  const client: GoogleOAuthClient = createGoogleOAuthClient(options);
  return {
    generateAuthUrl: (state) => client.buildAuthUrl(state),
    exchangeCode: (code) => client.exchangeCode(code),
    revokeToken: (token) => client.revoke(token),
    refreshAccessToken: (refreshToken) => client.refreshAccessToken(refreshToken),
  };
}

// ---------------------------------------------------------------------------
// CSRF state
// ---------------------------------------------------------------------------

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 200;

export interface OAuthStateStore {
  /** Creates a new random state valid for the TTL. */
  issue(): string;
  /**
   * Returns true exactly once per issued, unexpired state. The entry is removed on the first
   * lookup, whatever the outcome, so a state can never be replayed.
   */
  consume(state: string): boolean;
}

/** Short-lived in-memory set of pending OAuth states (single use, with expiry). */
export function createOAuthStateStore(
  now: () => number = Date.now,
  ttlMs: number = OAUTH_STATE_TTL_MS,
): OAuthStateStore {
  const pending = new Map<string, number>();

  const prune = (): void => {
    const time = now();
    for (const [state, expiresAt] of pending) {
      if (expiresAt <= time) pending.delete(state);
    }
    while (pending.size >= MAX_PENDING_STATES) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  };

  return {
    issue(): string {
      prune();
      const state = randomBytes(32).toString('base64url');
      pending.set(state, now() + ttlMs);
      return state;
    },
    consume(state: string): boolean {
      const expiresAt = pending.get(state);
      if (expiresAt === undefined) return false;
      pending.delete(state);
      return expiresAt > now();
    },
  };
}
