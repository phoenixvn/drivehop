import { describe, expect, it } from 'vitest';
import { ProviderError } from '@multicloud/shared';
import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_SCOPES,
  createGoogleOAuthClient,
  isDriveScopeGranted,
  isHttpsUrl,
} from './oauth.ts';
import { json, scriptedFetch } from './testFetch.ts';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const SECRET = 'GOCSPX-client-secret';
const NOW = 1_800_000_000_000;

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function idToken(claims: Record<string, unknown>): string {
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3600,
    sub: '1234',
    email: 'Someone@Example.com',
    email_verified: true,
    name: 'Nguyễn Văn A',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    ...claims,
  };
  return `${base64url('{"alg":"RS256"}')}.${base64url(JSON.stringify(payload))}.signature`;
}

function setup() {
  const fake = scriptedFetch();
  const client = createGoogleOAuthClient({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    redirectUri: 'http://localhost:8787/api/auth/google/callback',
    fetch: fake.fetch,
    now: () => NOW,
  });
  return { fake, client };
}

describe('Google OAuth client', () => {
  it('builds the consent URL', () => {
    const { client } = setup();
    const url = new URL(client.buildAuthUrl('state-123', { loginHint: 'a@b.c' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://localhost:8787/api/auth/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('false');
    expect(p.get('state')).toBe('state-123');
    expect(p.get('login_hint')).toBe('a@b.c');
    expect(p.get('scope')?.split(' ')).toEqual([...GOOGLE_SCOPES]);
    expect(url.toString()).not.toContain(SECRET);
    expect(new URL(client.buildAuthUrl('s')).searchParams.has('login_hint')).toBe(false);
  });

  it('exchanges the code and reads the identity from the id_token', async () => {
    const { fake, client } = setup();
    fake.once(() =>
      json(200, {
        access_token: 'ya29.access',
        expires_in: 3599,
        refresh_token: '1//refresh',
        scope: `openid ${GOOGLE_DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
        token_type: 'Bearer',
        id_token: idToken({}),
      }),
    );
    const result = await client.exchangeCode('auth-code');
    expect(result).toEqual({
      refreshToken: '1//refresh',
      profile: {
        email: 'Someone@Example.com',
        displayName: 'Nguyễn Văn A',
        avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
      },
      driveScopeGranted: true,
      accessToken: 'ya29.access',
      expiresAt: NOW + 3599 * 1000,
    });
    const req = fake.calls[0];
    expect(req?.method).toBe('POST');
    expect(req?.url.toString()).toBe('https://oauth2.googleapis.com/token');
    expect(req?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(req?.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: 'http://localhost:8787/api/auth/google/callback',
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
  });

  it('reports a missing Drive scope, a missing refresh token and drops non-https avatars', async () => {
    const { fake, client } = setup();
    fake.once(() =>
      json(200, {
        access_token: 'ya29.access',
        expires_in: 3600,
        scope: 'openid email profile',
        id_token: idToken({ name: '', picture: 'javascript:alert(1)' }),
      }),
    );
    const result = await client.exchangeCode('code');
    expect(result.driveScopeGranted).toBe(false);
    expect(result.refreshToken).toBeNull();
    expect(result.profile).toEqual({ email: 'Someone@Example.com', displayName: 'Someone@Example.com' });
  });

  it('verifies iss, aud, exp and email_verified of the id_token', async () => {
    for (const claims of [
      { iss: 'https://evil.example' },
      { aud: 'another-client' },
      { exp: Math.floor(NOW / 1000) - 3600 },
      { email_verified: false },
      { email: '' },
    ]) {
      const { fake, client } = setup();
      fake.once(() => json(200, { access_token: 'ya29.a', expires_in: 3600, id_token: idToken(claims) }));
      await expect(client.exchangeCode('code')).rejects.toThrow(Error);
    }
    const { fake, client } = setup();
    fake.once(() => json(200, { access_token: 'ya29.a', expires_in: 3600, id_token: 'not-a-jwt' }));
    await expect(client.exchangeCode('code')).rejects.toThrow(/malformed id_token/);
  });

  it('accepts the issuer without scheme and an audience list', async () => {
    const { fake, client } = setup();
    fake.once(() =>
      json(200, { access_token: 'ya29.a', expires_in: 3600, id_token: idToken({ iss: 'accounts.google.com', aud: [CLIENT_ID] }) }),
    );
    expect((await client.exchangeCode('code')).profile.email).toBe('Someone@Example.com');
  });

  it('falls back to the userinfo endpoint when there is no id_token', async () => {
    const { fake, client } = setup();
    fake.once(() => json(200, { access_token: 'ya29.a', expires_in: 3600 }));
    fake.once(() => json(200, { email: 'u@example.com', email_verified: true, name: 'U', picture: 'http://insecure/p' }));
    const result = await client.exchangeCode('code');
    expect(result.profile).toEqual({ email: 'u@example.com', displayName: 'U' });
    expect(fake.calls[1]?.url.toString()).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(fake.calls[1]?.headers.get('authorization')).toBe('Bearer ya29.a');
  });

  it('maps token endpoint errors without leaking the code or the secret', async () => {
    const { fake, client } = setup();
    fake.once(() => json(400, { error: 'invalid_grant', error_description: 'Bad Request' }));
    const error = await client.exchangeCode('secret-code').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'auth', status: 400 });
    expect((error as Error).message).not.toContain('secret-code');
    expect((error as Error).message).not.toContain(SECRET);

    fake.once(() => {
      throw new TypeError('fetch failed for https://oauth2.googleapis.com/token?code=leak');
    });
    const network = await client.refreshAccessToken('1//r').catch((err: unknown) => err);
    expect(network).toMatchObject({ kind: 'server', retryable: true });
    expect((network as Error).message).not.toContain('leak');

    fake.once(() => json(200, { token_type: 'Bearer' }));
    await expect(client.refreshAccessToken('1//r')).rejects.toThrow(/malformed token response/);
  });

  it('refreshes an access token and reports a rotated refresh token', async () => {
    const { fake, client } = setup();
    fake.once(() => json(200, { access_token: 'ya29.new', expires_in: 100, scope: GOOGLE_DRIVE_SCOPE }));
    expect(await client.refreshAccessToken('1//old')).toEqual({
      accessToken: 'ya29.new',
      expiresAt: NOW + 100_000,
      scope: GOOGLE_DRIVE_SCOPE,
    });
    expect(Object.fromEntries(new URLSearchParams(fake.calls[0]?.body as string))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: '1//old',
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });

    fake.once(() => json(200, { access_token: 'ya29.new', expires_in: 100, refresh_token: '1//rotated' }));
    expect((await client.refreshAccessToken('1//old')).refreshToken).toBe('1//rotated');
    fake.once(() => json(200, { access_token: 'ya29.new', expires_in: 100, refresh_token: '1//old' }));
    expect((await client.refreshAccessToken('1//old')).refreshToken).toBeUndefined();
  });

  it('revokes a token', async () => {
    const { fake, client } = setup();
    fake.once(() => new Response(null, { status: 200 }));
    await client.revoke('1//to-revoke');
    expect(fake.calls[0]?.url.toString()).toBe('https://oauth2.googleapis.com/revoke');
    expect(fake.calls[0]?.method).toBe('POST');
    expect(new URLSearchParams(fake.calls[0]?.body as string).get('token')).toBe('1//to-revoke');

    fake.once(() => json(400, { error: 'invalid_token', error_description: 'Token expired or revoked' }));
    await expect(client.revoke('x')).rejects.toMatchObject({ kind: 'unknown', status: 400 });
  });

  it('getUserInfo rejects unverified emails and maps 401', async () => {
    const { fake, client } = setup();
    fake.once(() => json(200, { email: 'u@example.com', email_verified: false }));
    await expect(client.getUserInfo('ya29.a')).rejects.toThrow(/not verified/);
    fake.once(() => json(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }));
    await expect(client.getUserInfo('ya29.a')).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
});

describe('scope and avatar helpers', () => {
  it('isDriveScopeGranted', () => {
    expect(isDriveScopeGranted(undefined)).toBe(true);
    expect(isDriveScopeGranted(null)).toBe(true);
    expect(isDriveScopeGranted(`openid ${GOOGLE_DRIVE_SCOPE}`)).toBe(true);
    expect(isDriveScopeGranted('openid email')).toBe(false);
  });

  it('isHttpsUrl', () => {
    expect(isHttpsUrl('https://lh3.googleusercontent.com/a')).toBe(true);
    for (const value of ['http://x', 'javascript:alert(1)', 'data:image/png;base64,AA', 'nope', 42, `https://x/${'a'.repeat(3000)}`]) {
      expect(isHttpsUrl(value)).toBe(false);
    }
  });
});
