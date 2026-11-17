import { timingSafeEqual } from 'node:crypto';
import { API_PATHS, AUTH_ERROR_CODES, AUTH_RESULT_PARAMS, isProviderError } from '@multicloud/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { authCallbackQuerySchema as callbackQuerySchema } from '@multicloud/core';
import { badRequest, notConfigured, tokenStorageUnavailable } from '../errors.ts';
import { OAUTH_STATE_TTL_MS } from '../google/oauth.ts';
import type { ExchangeResult } from '../google/oauth.ts';
import { parseOrBadRequest } from './deps.ts';
import type { RouteDeps } from './deps.ts';

export const OAUTH_STATE_COOKIE = 'mc_oauth_state';
const COOKIE_PATH = '/api/auth/google';

// Values of the `auth_error` query parameter: defined in the shared contract, re-exported here.
export { AUTH_ERROR_CODES };

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** GET /api/auth/google/start and GET /api/auth/google/callback */
export const authRoutes: FastifyPluginAsync<RouteDeps> = async (app, deps) => {
  const { config, accounts, cipher, oauth, stateStore } = deps;

  /** The redirect target is always the fixed WEB_ORIGIN; only the query parameter varies. */
  const redirectToWeb = (reply: FastifyReply, param: string, value: string): FastifyReply => {
    const target = new URL('/', config.webOrigin);
    target.searchParams.set(param, value);
    return reply.redirect(target.toString(), 302);
  };

  app.get(API_PATHS.authGoogleStart, async (_request, reply) => {
    if (oauth === null) throw notConfigured(deps.getStatus().missing);
    if (!cipher.available) throw tokenStorageUnavailable();

    const state = stateStore.issue();
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    });
    return reply.redirect(oauth.generateAuthUrl(state), 302);
  });

  app.get(API_PATHS.authGoogleCallback, async (request, reply) => {
    const query = parseOrBadRequest(callbackQuerySchema, request.query);
    const cookieState = request.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: COOKIE_PATH });

    // CSRF check. The state is consumed on first lookup, so it can never be used twice.
    const stateKnown = query.state !== undefined && stateStore.consume(query.state);
    if (
      query.state === undefined ||
      cookieState === undefined ||
      !sameString(cookieState, query.state) ||
      !stateKnown
    ) {
      throw badRequest('Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn. Hãy thử kết nối lại.');
    }

    if (oauth === null) throw notConfigured(deps.getStatus().missing);

    if (query.error !== undefined) {
      const code =
        query.error === 'access_denied' ? AUTH_ERROR_CODES.accessDenied : AUTH_ERROR_CODES.oauthError;
      return redirectToWeb(reply, AUTH_RESULT_PARAMS.error, code);
    }
    if (query.code === undefined) {
      return redirectToWeb(reply, AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.missingCode);
    }
    if (!cipher.available) {
      return redirectToWeb(reply, AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.storageUnavailable);
    }

    let exchanged: ExchangeResult;
    try {
      exchanged = await oauth.exchangeCode(query.code);
    } catch (err) {
      // Fixed fields only: never the message of an unknown error (it could quote the request).
      const provider = isProviderError(err) ? err : undefined;
      request.log.warn(
        {
          errorName: err instanceof Error ? err.name : 'unknown',
          status: provider?.status,
          kind: provider?.kind,
        },
        'Google OAuth code exchange failed',
      );
      return redirectToWeb(reply, AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.tokenExchangeFailed);
    }

    if (exchanged.driveScopeGranted === false) {
      // Linking this account would only produce 403s on every Drive call.
      return redirectToWeb(reply, AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.driveScopeMissing);
    }

    const { profile, refreshToken } = exchanged;
    if (refreshToken === null) {
      // Google only returns a refresh token on (re-)consent. Keep the stored one if there is one.
      const existing = accounts.findByEmail('google-drive', profile.email);
      if (existing === undefined || accounts.getRefreshTokenEnc(existing.id) === null) {
        return redirectToWeb(reply, AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.noRefreshToken);
      }
    }

    let refreshTokenEnc: Buffer | null = null;
    if (refreshToken !== null) {
      try {
        refreshTokenEnc = await cipher.encryptToken(refreshToken);
      } catch {
        return redirectToWeb(reply, AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.storageUnavailable);
      }
    }

    const { account } = accounts.upsert({
      provider: 'google-drive',
      email: profile.email,
      displayName: profile.displayName,
      ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
      refreshTokenEnc,
    });
    deps.invalidateProvider(account.id);
    request.log.info({ accountId: account.id }, 'Google account connected');
    return redirectToWeb(reply, AUTH_RESULT_PARAMS.connected, account.id);
  });
};
