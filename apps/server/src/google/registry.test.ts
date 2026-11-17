import { randomBytes } from 'node:crypto';
import type { CloudProvider } from '@multicloud/shared';
import { describe, expect, it, vi } from 'vitest';
import { createStaticKeySource } from '../crypto/keySource.ts';
import { createTokenCipher } from '../crypto/tokenCipher.ts';
import { createAccountsRepo } from '../db/accounts.ts';
import { openDatabase } from '../db/index.ts';
import { GOOGLE_SCOPES, createGoogleOAuth, createOAuthStateStore, isHttpsUrl } from './oauth.ts';
import type { GoogleAccessToken, GoogleOAuth } from './oauth.ts';
import { createProviderResolver } from './registry.ts';
import type { ProviderFactoryArgs } from './registry.ts';

function setup(options: { oauth?: GoogleOAuth | null } = {}) {
  const db = openDatabase({ memory: true });
  const accounts = createAccountsRepo(db);
  const cipher = createTokenCipher(createStaticKeySource(randomBytes(32)));
  let time = 1_000_000;
  let issued = 0;
  const refreshes: string[] = [];
  const nextResponse: { refreshToken?: string } = {};
  const oauth: GoogleOAuth = {
    generateAuthUrl: () => 'https://accounts.example/auth',
    exchangeCode: async () => {
      throw new Error('not used');
    },
    revokeToken: async () => undefined,
    refreshAccessToken: vi.fn(async (refreshToken: string): Promise<GoogleAccessToken> => {
      refreshes.push(refreshToken);
      issued += 1;
      const token: GoogleAccessToken = { accessToken: `access-${issued}`, expiresAt: time + 3_600_000 };
      if (nextResponse.refreshToken !== undefined) token.refreshToken = nextResponse.refreshToken;
      return token;
    }),
  };
  const built: ProviderFactoryArgs[] = [];
  const registry = createProviderResolver({
    accounts,
    cipher,
    oauth: options.oauth === undefined ? oauth : options.oauth,
    missingConfig: ['GOOGLE_CLIENT_ID'],
    now: () => time,
    createProvider: (args) => {
      built.push(args);
      return { id: 'google-drive', marker: built.length } as unknown as CloudProvider;
    },
  });
  const addAccount = async (email: string, token: string | null = 'refresh-1') =>
    accounts.upsert({
      provider: 'google-drive',
      email,
      displayName: email,
      refreshTokenEnc: token === null ? null : await cipher.encryptToken(token),
    }).account;
  const advance = (ms: number): void => {
    time += ms;
  };
  return { accounts, cipher, refreshes, nextResponse, built, registry, addAccount, advance };
}

describe('provider registry', () => {
  it('builds a provider per account, caches it and refreshes with the decrypted token', async () => {
    const { registry, addAccount, refreshes, built } = setup();
    const a = await addAccount('a@example.com', 'token-a');
    const b = await addAccount('b@example.com', 'token-b');

    const first = await registry.resolveProvider(a.id);
    expect(await registry.resolveProvider(a.id)).toBe(first);
    expect(await registry.resolveProvider(b.id)).not.toBe(first);
    expect(built.map((args) => args.accountId)).toEqual([a.id, b.id]);

    expect(await built[0]?.getAccessToken()).toBe('access-1');
    expect(await built[1]?.getAccessToken()).toBe('access-2');
    expect(refreshes).toEqual(['token-a', 'token-b']);

    registry.invalidate(a.id);
    expect(await registry.resolveProvider(a.id)).not.toBe(first);
  });

  it('caches the access token until shortly before expiry, single-flight, and force-refreshes', async () => {
    const { registry, addAccount, refreshes, built, advance } = setup();
    const account = await addAccount('a@example.com');
    await registry.resolveProvider(account.id);
    const args = built[0] as ProviderFactoryArgs;

    const [x, y] = await Promise.all([args.getAccessToken(), args.getAccessToken()]);
    expect([x, y]).toEqual(['access-1', 'access-1']);
    expect(await args.getAccessToken()).toBe('access-1');
    expect(refreshes).toHaveLength(1);

    expect(await args.getAccessToken({ forceRefresh: true })).toBe('access-2');
    advance(3_600_000 - 30_000); // inside the 60 s skew
    expect(await args.getAccessToken()).toBe('access-3');
    expect(refreshes).toHaveLength(3);
  });

  it('persists a rotated refresh token re-encrypted', async () => {
    const { registry, addAccount, accounts, cipher, built, nextResponse, refreshes } = setup();
    const account = await addAccount('a@example.com', 'old-token');
    await registry.resolveProvider(account.id);
    const before = accounts.getRefreshTokenEnc(account.id) as Buffer;

    await built[0]?.getAccessToken();
    expect(accounts.getRefreshTokenEnc(account.id)?.equals(before)).toBe(true);

    nextResponse.refreshToken = 'rotated-token';
    await built[0]?.getAccessToken({ forceRefresh: true });
    const after = accounts.getRefreshTokenEnc(account.id) as Buffer;
    expect(after.includes(Buffer.from('rotated-token'))).toBe(false);
    expect(await cipher.decryptToken(after)).toBe('rotated-token');

    delete nextResponse.refreshToken;
    await built[0]?.getAccessToken({ forceRefresh: true });
    expect(refreshes).toEqual(['old-token', 'old-token', 'rotated-token']);
  });

  it('marks the account needs_reconnect on an auth failure and stops resolving it', async () => {
    const { registry, addAccount, built, accounts } = setup();
    const account = await addAccount('a@example.com');
    await registry.resolveProvider(account.id);

    built[0]?.onAuthError();
    expect(accounts.get(account.id)?.status).toBe('needs_reconnect');
    await expect(registry.resolveProvider(account.id)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'auth',
      retryable: false,
    });
  });

  it('rejects unknown accounts, accounts without a token and undecryptable tokens', async () => {
    const { registry, addAccount, accounts, cipher } = setup();
    await expect(registry.resolveProvider('nope')).rejects.toMatchObject({ kind: 'not_found' });

    const noToken = await addAccount('none@example.com', null);
    await expect(registry.resolveProvider(noToken.id)).rejects.toMatchObject({ kind: 'auth' });

    const broken = await addAccount('broken@example.com');
    accounts.setRefreshTokenEnc(broken.id, randomBytes(60));
    await expect(registry.resolveProvider(broken.id)).rejects.toMatchObject({ kind: 'auth' });
    // A failed build is not cached: once the token is readable again the account resolves.
    accounts.setRefreshTokenEnc(broken.id, await cipher.encryptToken('fixed'));
    await expect(registry.resolveProvider(broken.id)).resolves.toMatchObject({ id: 'google-drive' });
  });

  it('answers 503 not_configured when Google OAuth is not configured', async () => {
    const { registry, addAccount } = setup({ oauth: null });
    const account = await addAccount('a@example.com');
    await expect(registry.resolveProvider(account.id)).rejects.toMatchObject({
      statusCode: 503,
      code: 'not_configured',
    });
  });

  it('getAccountEmail is synchronous and throws for unknown ids', async () => {
    const { registry, addAccount } = setup();
    const account = await addAccount('Mixed.Case@Example.com');
    expect(registry.getAccountEmail(account.id)).toBe('mixed.case@example.com');
    expect(() => registry.getAccountEmail('missing')).toThrow(/Unknown account/);
  });

  it('the default provider is the fetch-based core Drive provider', async () => {
    const accounts = createAccountsRepo(openDatabase({ memory: true }));
    const cipher = createTokenCipher(createStaticKeySource(randomBytes(32)));
    const oauth: GoogleOAuth = {
      generateAuthUrl: () => '',
      exchangeCode: async () => {
        throw new Error('not used');
      },
      revokeToken: async () => undefined,
      refreshAccessToken: async () => {
        throw new Error('no network in tests');
      },
    };
    const registry = createProviderResolver({ accounts, cipher, oauth });
    const { account } = accounts.upsert({
      provider: 'google-drive',
      email: 'a@example.com',
      displayName: 'A',
      refreshTokenEnc: await cipher.encryptToken('t'),
    });
    const provider = await registry.resolveProvider(account.id);
    expect(provider.id).toBe('google-drive');
    expect(typeof provider.generateIds).toBe('function');
    await expect(provider.getQuota()).rejects.toMatchObject({ name: 'ProviderError', kind: 'unknown' });
    expect(accounts.get(account.id)?.status).toBe('connected');
  });
});

describe('Google OAuth helpers', () => {
  it('builds the consent URL with offline access, forced consent, scopes and state', () => {
    const oauth = createGoogleOAuth({
      clientId: 'client-id.apps.googleusercontent.com',
      clientSecret: 'client-secret-value',
      redirectUri: 'http://localhost:8787/api/auth/google/callback',
    });
    const url = new URL(oauth.generateAuthUrl('state-123'));
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/auth/google/callback');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GOOGLE_SCOPES]);
    expect(GOOGLE_SCOPES).toEqual(['https://www.googleapis.com/auth/drive', 'openid', 'email', 'profile']);
    expect(url.toString()).not.toContain('client-secret-value');
  });

  it('issues single-use states that expire', () => {
    let time = 1_000;
    const store = createOAuthStateStore(() => time, 5_000);

    const used = store.issue();
    expect(store.consume(used)).toBe(true);
    expect(store.consume(used)).toBe(false);
    expect(store.consume('never-issued')).toBe(false);

    const expired = store.issue();
    time += 5_001;
    expect(store.consume(expired)).toBe(false);

    const a = store.issue();
    const b = store.issue();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});

describe('avatar URLs', () => {
  it('keeps only https URLs (the value ends up in <img src>)', () => {
    expect(isHttpsUrl('https://lh3.googleusercontent.com/a/photo=s96-c')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'http://x/a.png', '//x/a.png', 'not a url', '', undefined, 42]) {
      expect(isHttpsUrl(bad)).toBe(false);
    }
  });
});
