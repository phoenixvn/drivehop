// Test doubles for the host: a fake OAuth client, a reversible fake cipher and a provider factory
// backed by the in-memory FakeDrive of '@multicloud/core/testing'. Never used in production code.
import type { GoogleExchangeResult, GoogleOAuthClient, GoogleOAuthClientOptions, TokenCipher } from '@multicloud/core';
import { FakeDrive } from '@multicloud/core/testing';
import type { CloudProvider } from '@multicloud/shared';
import type { HostDeps } from '../hostDeps.ts';

/** base64 of 32 zero bytes: a syntactically valid test master key (not a secret). */
export const TEST_MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32)));

export const REFRESH_TOKEN_PREFIX = 'test-refresh-token-';

/** Reversible, NOT secure: prefix + byte-reversed UTF-8, so the plaintext never appears verbatim. */
export function fakeCipher(): TokenCipher {
  return {
    encrypt: async (plaintext) => {
      const bytes = new TextEncoder().encode(plaintext).reverse();
      const out = new Uint8Array(bytes.length + 4);
      out.set([0xfa, 0xce, 0xc1, 0x9f]);
      out.set(bytes, 4);
      return out;
    },
    decrypt: async (blob) => {
      if (blob[0] !== 0xfa || blob[1] !== 0xce) throw new Error('bad blob');
      return new TextDecoder().decode(new Uint8Array(blob.slice(4)).reverse());
    },
  };
}

export interface FakeOAuthState {
  /** code -> exchange result */
  codes: Map<string, GoogleExchangeResult>;
  created: GoogleOAuthClientOptions[];
  refreshed: string[];
  revoked: string[];
}

export function fakeOAuth(): { state: FakeOAuthState; create: (options: GoogleOAuthClientOptions) => GoogleOAuthClient } {
  const state: FakeOAuthState = { codes: new Map(), created: [], refreshed: [], revoked: [] };
  const create = (options: GoogleOAuthClientOptions): GoogleOAuthClient => {
    state.created.push(options);
    return {
      buildAuthUrl: (oauthState) =>
        `https://accounts.google.test/o/oauth2/v2/auth?state=${encodeURIComponent(oauthState)}&redirect_uri=${encodeURIComponent(options.redirectUri)}`,
      exchangeCode: async (code) => {
        const result = state.codes.get(code);
        if (result === undefined) throw new Error('invalid code');
        return result;
      },
      refreshAccessToken: async (refreshToken) => {
        state.refreshed.push(refreshToken);
        return { accessToken: `access-for-${refreshToken}`, expiresAt: Date.now() + 3_600_000 };
      },
      revoke: async (token) => {
        state.revoked.push(token);
      },
      getUserInfo: async () => ({ email: 'x@example.com', displayName: 'x' }),
    };
  };
  return { state, create };
}

export function exchangeResult(email: string, overrides: Partial<GoogleExchangeResult> = {}): GoogleExchangeResult {
  return {
    refreshToken: `${REFRESH_TOKEN_PREFIX}${email}`,
    profile: { email, displayName: email.split('@')[0] ?? email, avatarUrl: 'https://lh3.googleusercontent.test/a.png' },
    driveScopeGranted: true,
    accessToken: 'test-access-token',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

export interface TestHarness {
  drive: FakeDrive;
  oauth: FakeOAuthState;
  /** Subrequests made through the counting fetch handed to providers. */
  fetched: string[];
  deps: Partial<HostDeps>;
}

/**
 * Host deps for tests. `subrequestsPerCall` > 0 makes every provider method call go through the
 * counting fetch first (FakeProvider itself never fetches), so budget behaviour is observable.
 */
export function createTestHarness(options: { subrequestsPerCall?: number; timing?: Partial<HostDeps['timing']> } = {}): TestHarness {
  const drive = new FakeDrive();
  const oauth = fakeOAuth();
  const fetched: string[] = [];
  const perCall = options.subrequestsPerCall ?? 0;
  const deps: Partial<HostDeps> = {
    createOAuthClient: oauth.create,
    createCipher: async () => fakeCipher(),
    fetch: async (input) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response('ok');
    },
    createDriveProvider: (providerOptions): CloudProvider => {
      const target = drive.provider(providerOptions.accountId);
      if (perCall === 0) return target;
      const countingFetch = providerOptions.fetch ?? fetch;
      return new Proxy(target, {
        get(obj, prop, receiver) {
          const value = Reflect.get(obj, prop, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            for (let i = 0; i < perCall; i++) await countingFetch(`https://www.googleapis.test/${String(prop)}`);
            return (value as (...a: unknown[]) => unknown).apply(obj, args);
          };
        },
      });
    },
    envOverride: {
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.test',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      MULTICLOUD_MASTER_KEY: TEST_MASTER_KEY,
    },
    engineOptions: { progressThrottleMs: 0 },
    timing: {
      runBudgetMs: 60_000,
      // Alarms never fire on their own in tests: runDurableObjectAlarm() fires them explicitly.
      reArmDelayMs: 3_600_000,
      startDelayMs: 3_600_000,
      budgetCheckMs: 5,
      subrequestBudget: 7_500,
      subrequestSafetyMargin: 300,
      cancelGraceMs: 50,
      ...options.timing,
    },
    sse: { heartbeatMs: 40, quietCloseMs: 120, checkEveryMs: 10, idleRetryMs: 5_000 },
  };
  return { drive, oauth: oauth.state, fetched, deps };
}
