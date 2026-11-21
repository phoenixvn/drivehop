import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { createTransferEngine, isTransferError, redactSecrets } from '@multicloud/core';
import type { TransferEngineHandle, TransferEngineOptions } from '@multicloud/core';
import { API_ERROR_CODES, API_PATHS, isProviderError } from '@multicloud/shared';
import type { ApiError, EngineLogger, ProviderResolver } from '@multicloud/shared';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyServerOptions } from 'fastify';
import { buildStatus, loadConfig, missingGoogleVars } from './config.ts';
import type { AppConfig, ConfigStatus } from './config.ts';
import { MasterKeyUnavailableError, createMasterKeySource } from './crypto/keySource.ts';
import type { KeySource } from './crypto/keySource.ts';
import { loadOsKeyringEntry } from './crypto/keyring.ts';
import { createTokenCipher } from './crypto/tokenCipher.ts';
import { createAccountsRepo } from './db/accounts.ts';
import type { AccountsRepo } from './db/accounts.ts';
import { openDatabase } from './db/index.ts';
import type { Db } from './db/index.ts';
import { HttpError, providerErrorToHttp, tokenStorageUnavailable } from './errors.ts';
import { createGoogleOAuth, createOAuthStateStore } from './google/oauth.ts';
import type { GoogleOAuth } from './google/oauth.ts';
import { createProviderResolver } from './google/registry.ts';
import { accountRoutes } from './routes/accounts.ts';
import { authRoutes } from './routes/auth.ts';
import type { RouteDeps } from './routes/deps.ts';
import { statusRoutes } from './routes/status.ts';
import { transferRoutes } from './routes/transfers.ts';
import { setupRoutes } from './routes/setup.ts';
import { hasWebBuild, serveWebUi } from './static.ts';

/** Host the server binds to. Local only, never 0.0.0.0. */
export const LISTEN_HOST = '127.0.0.1';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Replacement for the built-in provider registry (tests, alternative providers). */
export interface ProviderOverrides {
  resolveProvider: ProviderResolver;
  getAccountEmail: (accountId: string) => string;
  invalidate?: (accountId: string) => void;
}

export interface BuildServerOptions {
  /** Defaults to `loadConfig()` (process env + repo-root `.env`). */
  config?: AppConfig;
  /** Defaults to the SQLite file in `config.dataDir`. Pass `openDatabase({ memory: true })` in tests. */
  db?: Db;
  /** Defaults to OS keyring with MULTICLOUD_MASTER_KEY as fallback. Inject in tests. */
  keySource?: KeySource;
  /** Defaults to a real Google OAuth client when configured, else `null`. Inject a fake in tests. */
  oauth?: GoogleOAuth | null;
  /** Defaults to the Google Drive registry built from db + key source + oauth. */
  providers?: ProviderOverrides;
  /** Fastify logger option. Defaults to pino at level 'info' with query strings stripped. */
  logger?: FastifyServerOptions['logger'];
  /** Clock used for OAuth state expiry. */
  now?: () => number;
  /** Options of the transfer engine (tests: `sleep`, concurrency, `progressThrottleMs`, ...). */
  engine?: TransferEngineOptions;
  /** How long POST /api/transfers/:id/cancel waits for a running job before answering. */
  cancelGraceMs?: number;
  /** Keep-alive interval of GET /api/events. */
  sseKeepAliveMs?: number;
  /**
   * Enables the in-app setup screen (POST /api/setup). Called after the Google OAuth client was
   * saved; the caller closes this server and builds a new one so the client is picked up.
   */
  onSetupSaved?: () => void;
}

export interface BuiltServer {
  /** Not listening yet: register more routes, then call `app.listen({ host: LISTEN_HOST, port })`. */
  app: FastifyInstance;
  /** better-sqlite3 handle, shared with the transfer engine. */
  db: Db;
  /** The transfer engine behind /api/transfers and /api/events. Closed by `app.close()`. */
  engine: TransferEngineHandle;
  config: AppConfig;
  resolveProvider: ProviderResolver;
  getAccountEmail: (accountId: string) => string;
  /** Same object GET /api/status returns. */
  getStatus: () => ConfigStatus;
  accounts: AccountsRepo;
}

function isLocalHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : (hostHeader.split(':')[0] ?? '');
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

function send(reply: { status(code: number): { send(body: ApiError): unknown } }, statusCode: number, body: ApiError): unknown {
  return reply.status(statusCode).send(body);
}

/**
 * Wires configuration, database, crypto, the provider registry, the transfer engine and all routes.
 * Boots without Google credentials: everything that needs Google then answers 503 `not_configured`.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<BuiltServer> {
  const config = options.config ?? loadConfig();
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase({ dataDir: config.dataDir });

  const keySource =
    options.keySource ??
    createMasterKeySource({
      keyring: await loadOsKeyringEntry(),
      envKeyBase64: config.masterKeyBase64,
    });
  const cipher = createTokenCipher(keySource);
  const accounts = createAccountsRepo(db);
  const onSetupSaved = options.onSetupSaved;
  const getStatus = (): ConfigStatus => {
    const status: ConfigStatus = buildStatus(config, keySource.keyringAvailable);
    if (onSetupSaved !== undefined) {
      status.setup = {
        allowed: accounts.list().length === 0,
        redirectUri: config.redirectUri,
        webOrigin: config.webOrigin,
      };
    }
    return status;
  };

  let oauth: GoogleOAuth | null;
  if (options.oauth !== undefined) {
    oauth = options.oauth;
  } else if (config.googleClientId !== null && config.googleClientSecret !== null) {
    oauth = createGoogleOAuth({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: config.redirectUri,
    });
  } else {
    oauth = null;
  }

  const app = Fastify({
    logger:
      options.logger ??
      {
        level: 'info',
        serializers: {
          // Never log query strings: the OAuth callback URL carries `code` and `state`.
          req: (request: { method?: string; url?: string }) => ({
            method: request.method,
            path: (request.url ?? '').split('?')[0],
          }),
        },
      },
  });

  const registry = createProviderResolver({
    accounts,
    cipher,
    oauth,
    missingConfig: missingGoogleVars(config),
    logger: {
      info: (message) => app.log.info(message),
      warn: (message) => app.log.warn(message),
    },
  });
  const resolveProvider = options.providers?.resolveProvider ?? registry.resolveProvider;
  const getAccountEmail = options.providers?.getAccountEmail ?? registry.getAccountEmail;
  const invalidateProvider = (accountId: string): void => {
    registry.invalidate(accountId);
    options.providers?.invalidate?.(accountId);
  };

  // The engine gets message strings only: the extra arguments it passes are raw error objects,
  // which must not reach the log (they can reference requests and their headers).
  const describeExtra = (args: unknown[]): string => {
    const errors = args.filter((arg): arg is Error => arg instanceof Error);
    return errors
      .map((err) => ` [${err.name}: ${redactSecrets(err.message).replace(/\s+/g, ' ').slice(0, 300)}]`)
      .join('');
  };
  const engineLogger: EngineLogger = {
    info: (message, ...args) => app.log.info(`${message}${describeExtra(args)}`),
    warn: (message, ...args) => app.log.warn(`${message}${describeExtra(args)}`),
    error: (message, ...args) => app.log.error(`${message}${describeExtra(args)}`),
  };
  const engine = createTransferEngine(
    { db, resolveProvider, getAccountEmail, logger: engineLogger },
    options.engine,
  );
  const eventStreams = new Set<() => void>();

  // Open event streams would keep the HTTP server from closing: end them first.
  app.addHook('preClose', async () => {
    for (const detach of [...eventStreams]) detach();
    eventStreams.clear();
  });
  // One hook, in this order: the engine's shutdown still writes to the database.
  app.addHook('onClose', async () => {
    await engine.close();
    if (ownsDb && db.open) db.close();
  });

  // Only answer requests addressed to this machine (blocks DNS-rebinding from web pages).
  app.addHook('onRequest', async (request, reply) => {
    if (!isLocalHost(request.headers.host)) {
      return reply
        .status(403)
        .send({ code: API_ERROR_CODES.badRequest, message: 'The server only accepts requests from localhost.' });
    }
    return undefined;
  });

  // Cross-site request forgery. CORS only stops a foreign page from READING responses; a "simple"
  // request (a POST without a body, a navigation) is still sent and acted upon. Browsers always
  // attach `Origin` to cross-origin POST/DELETE, so every state-changing request must come from the
  // web UI's origin (requests without an Origin header, e.g. curl, are not browser CSRF). The
  // Google callback is the one legitimate cross-site navigation (it is protected by the OAuth
  // state + cookie instead); every other request that a browser marks as cross-site is refused.
  app.addHook('onRequest', async (request, reply) => {
    const forbidden = (): FastifyReply =>
      reply
        .status(403)
        .send({ code: API_ERROR_CODES.badRequest, message: 'Request refused: it did not come from the DriveHop UI.' });
    const origin = request.headers.origin;
    const safeMethod = request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
    if (!safeMethod && origin !== undefined && origin !== config.webOrigin) return forbidden();
    const path = request.url.split('?')[0];
    if (request.headers['sec-fetch-site'] === 'cross-site' && path !== API_PATHS.authGoogleCallback) {
      return forbidden();
    }
    return undefined;
  });

  const webDist = config.webDist !== null && hasWebBuild(config.webDist) ? config.webDist : null;
  if (config.webDist !== null && webDist === null) {
    app.log.warn('WEB_DIST is set but contains no index.html: the web UI is not served on this port.');
  }
  app.setNotFoundHandler((request, reply) => {
    if (webDist !== null && serveWebUi(webDist, request, reply)) return;
    send(reply, 404, { code: API_ERROR_CODES.notFound, message: 'Path not found.' });
  });

  // Every error becomes { code, message }. Stack traces, tokens and upstream error objects
  // (which can carry Authorization headers) are never sent to the client nor logged.
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      return send(reply, error.statusCode, { code: error.code, message: error.message });
    }
    if (isTransferError(error)) {
      return send(reply, error.httpStatus, { code: error.code, message: redactSecrets(error.message) });
    }
    if (isProviderError(error)) {
      const { statusCode, body } = providerErrorToHttp(error);
      request.log.warn(
        { kind: error.kind, status: error.status, detail: error.code, retryable: error.retryable },
        'provider error',
      );
      return send(reply, statusCode, body);
    }
    if (error instanceof MasterKeyUnavailableError) {
      const unavailable = tokenStorageUnavailable();
      return send(reply, unavailable.statusCode, { code: unavailable.code, message: unavailable.message });
    }
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return send(reply, statusCode, {
        code: statusCode === 404 ? API_ERROR_CODES.notFound : API_ERROR_CODES.badRequest,
        message: 'Invalid request.',
      });
    }
    request.log.error(
      {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
      },
      'unhandled error',
    );
    return send(reply, 500, { code: API_ERROR_CODES.internal, message: 'Internal server error.' });
  });

  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);

  const deps: RouteDeps = {
    config,
    getStatus,
    accounts,
    cipher,
    oauth,
    stateStore: createOAuthStateStore(options.now),
    resolveProvider,
    invalidateProvider,
  };
  await app.register(statusRoutes, deps);
  await app.register(authRoutes, deps);
  await app.register(accountRoutes, deps);

  if (onSetupSaved !== undefined) {
    await app.register(setupRoutes, { config, accounts, onSetupSaved });
  }

  await app.register(transferRoutes, {
    engine,
    accounts,
    getStatus,
    webOrigin: config.webOrigin,
    eventStreams,
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
    ...(options.sseKeepAliveMs === undefined ? {} : { sseKeepAliveMs: options.sseKeepAliveMs }),
  });

  const status = getStatus();
  if (!status.configured) {
    app.log.warn(
      `DriveHop is not configured: missing ${status.missing.join(', ')}. ` +
        (onSetupSaved !== undefined
          ? 'Enter them on the setup screen of the web UI, or set them in the .env file and restart. '
          : 'Set them in the .env file at the repository root (see .env.example) and restart. ') +
        'Until then every Google feature answers 503 not_configured.',
    );
  }
  if (!keySource.available) {
    app.log.warn(
      'No master key available: the OS credential store cannot be used and MULTICLOUD_MASTER_KEY is not set. ' +
        'Accounts cannot be connected until one of them works (tokens are never stored unencrypted).',
    );
  } else if (!status.keyringAvailable) {
    app.log.warn('OS credential store unavailable: using MULTICLOUD_MASTER_KEY to encrypt stored tokens.');
  }

  return { app, db, engine, config, resolveProvider, getAccountEmail, getStatus, accounts };
}
