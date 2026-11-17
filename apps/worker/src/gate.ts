// Front door of the Worker: Cloudflare Access on EVERY request (API, event stream, static assets),
// then the CSRF checks carried over from apps/server/src/app.ts.
import { API_ERROR_CODES, API_PATHS } from '@multicloud/shared';
import { ACCESS_JWT_HEADER, normalizeTeamDomain } from './access.ts';
import type { AccessVerifier } from './access.ts';
import type { WorkerEnv } from './env.ts';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

/** Plain body of every refused request: no detail about why (no oracle for an attacker). */
const FORBIDDEN_TEXT = 'Truy cập bị từ chối. / Access denied.\n';

export function forbidden(): Response {
  return new Response(FORBIDDEN_TEXT, {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * The ONLY way around Access, for `wrangler dev` on the developer's machine. All must hold:
 * - DEV_AUTH_BYPASS is exactly 'true' (it exists only in .dev.vars; it is never declared in
 *   wrangler.jsonc, so a deployed Worker does not have it);
 * - ACCESS_TEAM_DOMAIN is NOT configured (a configured Access setup is always enforced);
 * - the request URL's hostname is exactly 127.0.0.1 or localhost (on Cloudflare the hostname is
 *   the routed custom domain, so this cannot match there).
 * Nothing from the request other than its URL hostname is consulted (no header, no query).
 */
export function isDevBypassAllowed(request: Request, env: WorkerEnv): boolean {
  if (env.DEV_AUTH_BYPASS !== 'true') return false;
  if (typeof env.ACCESS_TEAM_DOMAIN === 'string' && env.ACCESS_TEAM_DOMAIN.trim() !== '') return false;
  if (typeof env.ACCESS_AUD === 'string' && env.ACCESS_AUD.trim() !== '') return false;
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname);
}

/** True when Access is configured well enough to be enforced (otherwise everything is refused). */
export function isAccessConfigured(env: WorkerEnv): boolean {
  return normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN) !== null && (env.ACCESS_AUD ?? '').trim() !== '';
}

/** Returns a refusal Response, or null when the request may proceed. */
export async function authenticate(request: Request, env: WorkerEnv, verifier: AccessVerifier): Promise<Response | null> {
  if (isDevBypassAllowed(request, env)) return null;
  const result = await verifier.verify(request.headers.get(ACCESS_JWT_HEADER), {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
  });
  return result.ok ? null : forbidden();
}

/**
 * Response headers set on EVERY response of the Worker (assets, API, redirects, refusals). Static
 * asset "_headers" rules do not apply when assets.run_worker_first is true
 * (developers.cloudflare.com/workers/static-assets/headers/), so they are attached here. The Access
 * session cookie may be SameSite=None (admin's choice), so frame-ancestors 'none' also blocks
 * clickjacking of the transfer dialogs. Existing headers of a response are never overwritten.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};

export function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  return out;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Cross-site request forgery (same rules as the Node host, adapted to one origin):
 * - a state-changing request (not GET/HEAD/OPTIONS) that carries an Origin must come from the
 *   Worker's own origin (exact match with the request URL's origin, no wildcard);
 * - an /api/* request a browser marks `Sec-Fetch-Site: cross-site` is refused, except the Google
 *   callback (a legitimate cross-site navigation protected by the OAuth state + cookie).
 *   Page loads are not refused: the first load after the Access login is a cross-site navigation.
 */
export function checkCsrf(request: Request): Response | null {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const origin = request.headers.get('Origin');
  const message = 'Yêu cầu bị từ chối vì không đến từ giao diện MultiCloud.';
  if (!safe && origin !== null && origin !== url.origin) {
    return jsonError(403, API_ERROR_CODES.badRequest, message);
  }
  if (
    url.pathname.startsWith('/api/') &&
    request.headers.get('Sec-Fetch-Site') === 'cross-site' &&
    url.pathname !== API_PATHS.authGoogleCallback
  ) {
    return jsonError(403, API_ERROR_CODES.badRequest, message);
  }
  return null;
}
