// Host-independent: Web-standard APIs only (fetch, URL, URLSearchParams, atob, TextDecoder).
// No `node:` import, no `Buffer`, no `process`, no google-auth-library.
//
// Endpoints (developers.google.com/identity/protocols/oauth2/web-server and
// developers.google.com/identity/openid-connect/openid-connect):
//   authorization  https://accounts.google.com/o/oauth2/v2/auth
//   token          https://oauth2.googleapis.com/token   (authorization_code, refresh_token)
//   revoke         https://oauth2.googleapis.com/revoke  (POST form `token`; 200 ok, 400 error)
//   userinfo       https://openidconnect.googleapis.com/v1/userinfo
import { ProviderError } from '@multicloud/shared';
import { mapGoogleError } from './errors.ts';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];
/** Tolerated clock difference when checking the id_token expiry. */
const ID_TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Scopes requested on the consent screen (same list as apps/server/src/google/oauth.ts). */
export const GOOGLE_SCOPES: readonly string[] = [GOOGLE_DRIVE_SCOPE, 'openid', 'email', 'profile'];

export interface GoogleProfile {
  email: string;
  /** The account's name, or the email address when Google reports no name. */
  displayName: string;
  /** Only ever an https URL (see `isHttpsUrl`); absent otherwise. */
  avatarUrl?: string;
}

/** A short-lived access token as returned by the token endpoint. */
export interface GoogleAccessToken {
  accessToken: string;
  /** Epoch milliseconds: `now() + expires_in * 1000`. */
  expiresAt: number;
  /** Space-separated scopes when Google reported them. */
  scope?: string;
  /** Present only when Google rotated the refresh token; the caller must store it (encrypted). */
  refreshToken?: string;
}

/** Result of the authorization-code exchange (superset of the Node host's `ExchangeResult`). */
export interface GoogleExchangeResult {
  /** `null` when Google did not return a refresh token (it only does on first consent). */
  refreshToken: string | null;
  /** Identity of the account that consented; the email must be verified. */
  profile: GoogleProfile;
  /**
   * `false` when Google reported the granted scopes and the Drive scope is not among them
   * (the consent screen lets the user untick it). `true` otherwise. See `isDriveScopeGranted`.
   */
  driveScopeGranted: boolean;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface BuildAuthUrlOptions {
  /** Pre-selects an account on Google's sign-in page (`login_hint`). */
  loginHint?: string;
}

export interface GoogleOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  /** Must equal a redirect URI registered for the OAuth client, e.g. https://host/api/auth/google/callback */
  redirectUri: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

/**
 * Google OAuth 2.0 for a "Web application" client on plain fetch.
 * Every method that talks to Google rejects with a ProviderError built by `mapGoogleError`
 * (`invalid_grant` -> kind 'auth'); malformed success responses reject with a plain Error.
 * No error message, log line or return value other than the documented token fields may contain
 * a token, the authorization code or the client secret.
 */
export interface GoogleOAuthClient {
  /**
   * URL of the consent screen: response_type=code, access_type=offline, prompt=consent,
   * include_granted_scopes=false, scope = GOOGLE_SCOPES, plus `state` and the redirect URI.
   */
  buildAuthUrl(state: string, options?: BuildAuthUrlOptions): string;
  /** authorization_code grant; also resolves the identity (verified id_token claims or userinfo). */
  exchangeCode(code: string): Promise<GoogleExchangeResult>;
  /** refresh_token grant. */
  refreshAccessToken(refreshToken: string): Promise<GoogleAccessToken>;
  /** Revokes a refresh or access token at Google. Does not touch any Drive data. */
  revoke(token: string): Promise<void>;
  /** Identity behind an access token (userinfo endpoint). Rejects when the email is not verified. */
  getUserInfo(accessToken: string): Promise<GoogleProfile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Network failure (fetch rejected): a retryable server error whose message carries no request data. */
function networkError(): ProviderError {
  return new ProviderError('Google could not be reached', { kind: 'server', retryable: true });
}

async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Decodes the (unverified) claims of a JWT. Returns undefined when it is not a JWT. */
function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload === '') return undefined;
  try {
    let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    return isRecord(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the profile from id_token claims or a userinfo response (same claim names). */
function profileFromClaims(claims: Record<string, unknown>): GoogleProfile {
  const email = nonEmptyString(claims.email);
  if (email === undefined) throw new Error('Google did not report an email address for this account');
  // `email_verified` is a boolean in id_tokens; some responses have used the string "true".
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new Error('The email address of the Google account is not verified');
  }
  const profile: GoogleProfile = { email, displayName: nonEmptyString(claims.name) ?? email };
  if (isHttpsUrl(claims.picture)) profile.avatarUrl = claims.picture;
  return profile;
}

export function createGoogleOAuthClient(options: GoogleOAuthClientOptions): GoogleOAuthClient {
  const { clientId, clientSecret, redirectUri } = options;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;

  const post = async (url: string, form: Record<string, string>): Promise<unknown> => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
      });
    } catch {
      throw networkError();
    }
    const body = await readBody(res);
    if (!res.ok) throw mapGoogleError(res.status, body, res.headers);
    return body;
  };

  const tokenRequest = async (form: Record<string, string>): Promise<Record<string, unknown>> => {
    const body = await post(GOOGLE_TOKEN_ENDPOINT, { ...form, client_id: clientId, client_secret: clientSecret });
    if (!isRecord(body) || nonEmptyString(body.access_token) === undefined) {
      throw new Error('Google returned a malformed token response');
    }
    return body;
  };

  const accessTokenFrom = (body: Record<string, unknown>, issuedAt: number): GoogleAccessToken => {
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 3600;
    const token: GoogleAccessToken = {
      accessToken: body.access_token as string,
      expiresAt: issuedAt + expiresIn * 1000,
    };
    const scope = nonEmptyString(body.scope);
    if (scope !== undefined) token.scope = scope;
    const refreshToken = nonEmptyString(body.refresh_token);
    if (refreshToken !== undefined) token.refreshToken = refreshToken;
    return token;
  };

  /**
   * Identity from the id_token of the token response. The token comes straight from Google's
   * token endpoint over HTTPS, which the OpenID Connect guide accepts without a signature check;
   * iss, aud and exp are still verified.
   */
  const verifiedIdTokenClaims = (idToken: string): Record<string, unknown> => {
    const claims = decodeJwtClaims(idToken);
    if (claims === undefined) throw new Error('Google returned a malformed id_token');
    if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
      throw new Error('The id_token was not issued by Google');
    }
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(clientId)) throw new Error('The id_token was issued for another client');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 + ID_TOKEN_CLOCK_SKEW_MS < now()) {
      throw new Error('The id_token has expired');
    }
    return claims;
  };

  const getUserInfo = async (accessToken: string): Promise<GoogleProfile> => {
    let res: Response;
    try {
      res = await doFetch(GOOGLE_USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        redirect: 'manual',
      });
    } catch {
      throw networkError();
    }
    const body = await readBody(res);
    if (!res.ok) throw mapGoogleError(res.status, body, res.headers);
    if (!isRecord(body)) throw new Error('Google returned a malformed userinfo response');
    return profileFromClaims(body);
  };

  return {
    buildAuthUrl(state: string, buildOptions?: BuildAuthUrlOptions): string {
      const url = new URL(GOOGLE_AUTH_ENDPOINT);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('include_granted_scopes', 'false');
      url.searchParams.set('state', state);
      const hint = buildOptions?.loginHint;
      if (hint !== undefined && hint !== '') url.searchParams.set('login_hint', hint);
      return url.toString();
    },

    async exchangeCode(code: string): Promise<GoogleExchangeResult> {
      const issuedAt = now();
      const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      const token = accessTokenFrom(body, issuedAt);
      const idToken = nonEmptyString(body.id_token);
      const profile =
        idToken === undefined ? await getUserInfo(token.accessToken) : profileFromClaims(verifiedIdTokenClaims(idToken));
      return {
        refreshToken: token.refreshToken ?? null,
        profile,
        driveScopeGranted: isDriveScopeGranted(token.scope),
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
      };
    },

    async refreshAccessToken(refreshToken: string): Promise<GoogleAccessToken> {
      const issuedAt = now();
      const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
      const token = accessTokenFrom(body, issuedAt);
      // Only a DIFFERENT refresh token is a rotation the caller has to store.
      if (token.refreshToken === refreshToken) delete token.refreshToken;
      return token;
    },

    async revoke(token: string): Promise<void> {
      await post(GOOGLE_REVOKE_ENDPOINT, { token });
    },

    getUserInfo,
  };
}

/**
 * Granted-scope check for the `scope` field of a token response. True when Google did not report
 * scopes at all (null / undefined) or when the Drive scope is among them; false when scopes were
 * reported without the Drive scope.
 */
export function isDriveScopeGranted(scope: string | null | undefined): boolean {
  if (typeof scope !== 'string') return true;
  return scope.split(/\s+/).includes(GOOGLE_DRIVE_SCOPE);
}

/** The avatar is rendered as <img src>: only https URLs are kept (no javascript:, data:, http:). */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
