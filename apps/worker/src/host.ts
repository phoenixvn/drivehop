// Everything the singleton Durable Object does: accounts + OAuth (SQLite), the HTTP contract of
// packages/shared/src/api.ts, the transfer engine in manual mode driven by alarms, and the SSE stream.
import {
  HttpError,
  accountParamsSchema,
  authCallbackQuerySchema,
  badRequest,
  createTransferEngine,
  createTransferSchema,
  folderPathParamsSchema,
  isHttpsUrl,
  isTransferError,
  jobParamsSchema,
  listFilesQuerySchema,
  notFound,
  purgeTrashedSchema,
  parseOrBadRequest,
  providerErrorToHttp,
  redactSecrets,
} from '@multicloud/core';
import type { TokenCipher, TransferEngineHandle, TransferEngineOptions } from '@multicloud/core';
import {
  API_ERROR_CODES,
  API_PATHS,
  AUTH_ERROR_CODES,
  AUTH_RESULT_PARAMS,
  ROOT_FOLDER_ID,
  isProviderError,
  isTerminalJobStatus,
} from '@multicloud/shared';
import type {
  ApiError,
  Breadcrumb,
  CloudProvider,
  CreateTransferRequest,
  EngineLogger,
  FileEntry,
  StatusResponse,
} from '@multicloud/shared';
import { AccountsRepo, OAuthStateStore, OAUTH_STATE_TTL_MS, migrateWorkerTables } from './accounts.ts';
import { countingFetch, createBudgetFacade } from './budget.ts';
import type { BudgetFacade } from './budget.ts';
import type { WorkerEnv } from './env.ts';
import type { HostDeps } from './hostDeps.ts';
import { createWorkerRegistry, notConfigured, tokenStorageUnavailable } from './registry.ts';
import type { WorkerRegistry } from './registry.ts';
import { fromDurableObject as fromStorage } from './sqlDb.ts';
import { createSseResponse } from './sse.ts';

/** Google resumable uploads use 8 MiB chunks (the engine default). */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/**
 * Largest file the stream fallback (download, then chunked upload) accepts in one alarm run:
 * 2 GiB = 256 chunks of 8 MiB. A paused stream restarts from zero in the next run, so a file has to
 * fit into one 10-minute run: 2 GiB needs ~3.5 MiB/s sustained, which leaves margin, and 256 chunk
 * uploads stay below the per-item safety margin of the subrequest budget. Server-side copies (the
 * normal path) are not capped.
 */
export const MAX_STREAM_BYTES = 256 * UPLOAD_CHUNK_BYTES;
/**
 * Re-arm backoff for runs that finished nothing (no item reached done/failed and no job ended):
 * e.g. a stream-fallback file that cannot finish within one run restarts from byte 0 every run.
 * The delay doubles per stalled run up to this cap instead of re-arming every second forever.
 */
export const MAX_STALLED_REARM_DELAY_MS = 15 * 60_000;
/** Longest single sleep inside a run (engine retry backoff, provider retry waits). */
export const MAX_INLINE_SLEEP_MS = 4_000;
/** Maximum breadcrumb depth (same as the Node host). */
export const MAX_BREADCRUMB_DEPTH = 50;
/**
 * Trashed originals deleted forever per POST .../purge-trashed request. Each costs about three
 * subrequests (destination check, trash-state check, delete); 150 stays far below the limit.
 */
export const PURGE_BATCH_PER_REQUEST = 150;

const COOKIE_PATH = '/api/auth/google';
/** `__Host-` would require Path=/ (MDN, Set-Cookie prefixes); `__Secure-` allows the narrow path. */
const SECURE_COOKIE_NAME = '__Secure-mc_oauth';
/** Plain-http local development (wrangler dev on 127.0.0.1) cannot use a `__Secure-` name. */
const LOCAL_COOKIE_NAME = 'mc_oauth';

const JSON_HEADERS = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function apiError(status: number, body: ApiError): Response {
  return json(body, status);
}

function oauthCookieName(url: URL): string {
  return url.protocol === 'https:' ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie');
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function oauthCookie(url: URL, value: string, maxAgeS: number): string {
  return `${oauthCookieName(url)}=${value}; Max-Age=${maxAgeS}; Path=${COOKIE_PATH}; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (setCookie !== undefined) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 302, headers });
}

/** Valid MULTICLOUD_MASTER_KEY: base64 / base64url of exactly 32 bytes. */
export function isValidMasterKey(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (text === '' || !/^[A-Za-z0-9+/]+$/.test(text) || text.length % 4 === 1) return false;
  try {
    return atob(text + '='.repeat((4 - (text.length % 4)) % 4)).length === 32;
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Path from the account root down to `folderId` (same algorithm as apps/server/src/routes/accounts.ts). */
export async function buildBreadcrumbs(provider: CloudProvider, folderId: string): Promise<Breadcrumb[]> {
  const root = await provider.getFile(ROOT_FOLDER_ID);
  const rootCrumb: Breadcrumb = { id: ROOT_FOLDER_ID, name: root.name };
  if (folderId === ROOT_FOLDER_ID || folderId === root.id) return [rootCrumb];
  const chain: Breadcrumb[] = [];
  const seen = new Set<string>();
  let current: FileEntry | undefined = await provider.getFile(folderId);
  while (current !== undefined && chain.length < MAX_BREADCRUMB_DEPTH) {
    if (current.id === root.id) {
      chain.push(rootCrumb);
      break;
    }
    chain.push({ id: current.id, name: current.name });
    seen.add(current.id);
    const parentId: string | undefined = current.parents[0];
    if (parentId === undefined || seen.has(parentId)) break;
    if (parentId === root.id) {
      chain.push(rootCrumb);
      break;
    }
    try {
      current = await provider.getFile(parentId);
    } catch (err) {
      if (isProviderError(err) && (err.kind === 'not_found' || err.kind === 'forbidden')) break;
      throw err;
    }
  }
  return chain.reverse();
}

/** Only message strings reach the log: extra arguments are raw errors (they may reference requests). */
function describeExtra(args: unknown[]): string {
  return args
    .filter((arg): arg is Error => arg instanceof Error)
    .map((err) => ` [${err.name}: ${redactSecrets(err.message).replace(/\s+/g, ' ').slice(0, 300)}]`)
    .join('');
}

const consoleLogger: EngineLogger = {
  info: (message, ...args) => console.log(`${redactSecrets(message)}${describeExtra(args)}`),
  warn: (message, ...args) => console.warn(`${redactSecrets(message)}${describeExtra(args)}`),
  error: (message, ...args) => console.error(`${redactSecrets(message)}${describeExtra(args)}`),
};

type RouteParams = Record<string, string>;
type Handler = (request: Request, url: URL, params: RouteParams) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}$`), keys };
}

export interface CoreHostOptions {
  storage: DurableObjectStorage;
  env: WorkerEnv;
  deps: HostDeps;
  waitUntil: (promise: Promise<unknown>) => void;
  logger?: EngineLogger;
}

export class CoreHost {
  readonly engine: TransferEngineHandle;
  readonly accounts: AccountsRepo;
  readonly states: OAuthStateStore;
  readonly registry: WorkerRegistry;
  readonly budget: BudgetFacade;
  private readonly storage: DurableObjectStorage;
  private readonly env: WorkerEnv;
  private readonly deps: HostDeps;
  private readonly logger: EngineLogger;
  private readonly waitUntil: (promise: Promise<unknown>) => void;
  private readonly routes: Route[] = [];
  private readonly googleFetch: typeof fetch;
  private cipherPromise: Promise<TokenCipher> | null = null;
  private runActive = false;
  /** Consecutive alarm runs that made no progress (in memory; an eviction resets it). */
  stalledRuns = 0;
  /** Number of alarm runs in this instance (observability / tests). */
  runs = 0;

  constructor(options: CoreHostOptions) {
    this.storage = options.storage;
    this.env = options.env;
    this.deps = options.deps;
    this.logger = options.logger ?? consoleLogger;
    this.waitUntil = options.waitUntil;
    migrateWorkerTables(this.storage);
    this.accounts = new AccountsRepo(this.storage, this.deps.now);
    this.states = new OAuthStateStore(this.storage, this.deps.now);
    this.budget = createBudgetFacade();
    this.googleFetch = countingFetch(this.deps.fetch, this.budget);

    const sleepCapped = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, MAX_INLINE_SLEEP_MS))));
    this.registry = createWorkerRegistry({
      accounts: this.accounts,
      oauthCredentials: () => this.oauthCredentials(),
      missingConfig: () => this.missingConfig(),
      getCipher: () => this.getCipher(),
      createOAuthClient: this.deps.createOAuthClient,
      createDriveProvider: (providerOptions) => this.deps.createDriveProvider({ ...providerOptions, sleep: sleepCapped }),
      fetch: this.googleFetch,
      now: this.deps.now,
      logger: this.logger,
    });

    const engineOptions: TransferEngineOptions = {
      ...this.deps.engineOptions,
      manual: true,
      maxStreamBytes: MAX_STREAM_BYTES,
      budget: this.budget,
      // Alarm-friendly backoff: no wait inside a run is longer than a few seconds.
      retry: { maxDelayMs: MAX_INLINE_SLEEP_MS, ...this.deps.engineOptions?.retry },
    };
    this.engine = createTransferEngine(
      {
        db: fromStorage(this.storage),
        resolveProvider: this.registry.resolveProvider,
        getAccountEmail: this.registry.getAccountEmail,
        logger: this.logger,
      },
      engineOptions,
    );
    this.registerRoutes();
  }

  // ------------------------------------------------------------------ configuration

  private oauthCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId = nonEmpty(this.env.GOOGLE_CLIENT_ID);
    const clientSecret = nonEmpty(this.env.GOOGLE_CLIENT_SECRET);
    return clientId === null || clientSecret === null ? null : { clientId, clientSecret };
  }

  private missingConfig(): string[] {
    const missing: string[] = [];
    if (nonEmpty(this.env.GOOGLE_CLIENT_ID) === null) missing.push('GOOGLE_CLIENT_ID');
    if (nonEmpty(this.env.GOOGLE_CLIENT_SECRET) === null) missing.push('GOOGLE_CLIENT_SECRET');
    if (!isValidMasterKey(this.env.MULTICLOUD_MASTER_KEY)) missing.push('MULTICLOUD_MASTER_KEY');
    return missing;
  }

  status(): StatusResponse {
    const missing = this.missingConfig();
    // There is no OS keyring on Workers: the master key is a Worker secret. A missing or invalid key
    // is reported through `configured` / `missing`, so `keyringAvailable` stays true (otherwise the
    // web UI would show its OS-keyring warning, which does not apply here).
    return { configured: missing.length === 0, missing, keyringAvailable: true };
  }

  private getCipher(): Promise<TokenCipher> {
    const key = this.env.MULTICLOUD_MASTER_KEY;
    if (!isValidMasterKey(key) || key === undefined) return Promise.reject(tokenStorageUnavailable());
    this.cipherPromise ??= this.deps.createCipher(key.trim()).catch(() => {
      this.cipherPromise = null;
      throw tokenStorageUnavailable();
    });
    return this.cipherPromise;
  }

  // ------------------------------------------------------------------ alarms

  /** Called once at construction: an evicted object resumes unfinished work. */
  async resumeIfNeeded(): Promise<void> {
    if (this.engine.hasWork()) await this.ensureAlarm();
  }

  /** Schedules a run unless one is active or an alarm is already pending. */
  async ensureAlarm(): Promise<void> {
    if (this.runActive) return;
    const pending = await this.storage.getAlarm();
    if (pending === null) await this.storage.setAlarm(this.deps.now() + this.deps.timing.startDelayMs);
  }

  /**
   * One alarm run: start the engine, wait until idle / wall-clock budget / subrequest budget,
   * pause, sweep leftover temporary permissions, re-arm while work remains. Never throws (an alarm
   * that throws is retried only 6 times by the platform; this loop re-arms itself instead).
   */
  /** Finished items plus finished jobs: grows whenever a run completes anything. */
  private progressMark(): number {
    let mark = 0;
    for (const job of this.engine.listJobs()) {
      mark += job.totals.done + job.totals.failed + (isTerminalJobStatus(job.status) ? 1 : 0);
    }
    return mark;
  }

  /** Delay of the next alarm while work remains (backs off while runs make no progress). */
  nextRunDelayMs(): number {
    const base = this.deps.timing.reArmDelayMs;
    if (this.stalledRuns === 0) return base;
    return Math.min(MAX_STALLED_REARM_DELAY_MS, Math.max(base, 1_000) * 2 ** Math.min(this.stalledRuns, 20));
  }

  async runAlarm(): Promise<void> {
    if (this.runActive) return;
    this.runActive = true;
    this.runs++;
    const before = this.progressMark();
    const { timing } = this.deps;
    const runBudget = this.budget.beginRun({ limit: timing.subrequestBudget, safetyMargin: timing.subrequestSafetyMargin });
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let budgetTimer: ReturnType<typeof setInterval> | undefined;
    try {
      this.engine.start();
      await Promise.race([
        this.engine.whenIdle(),
        new Promise<void>((resolve) => {
          wallTimer = setTimeout(resolve, timing.runBudgetMs);
        }),
        new Promise<void>((resolve) => {
          budgetTimer = setInterval(() => {
            if (!runBudget.canStartItem()) resolve();
          }, timing.budgetCheckMs);
        }),
      ]);
    } catch (err) {
      this.logger.error('alarm: run failed', err);
    } finally {
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      if (budgetTimer !== undefined) clearInterval(budgetTimer);
    }
    try {
      await this.engine.pause();
      await this.engine.cleanupOrphanPermissions();
    } catch (err) {
      this.logger.error('alarm: pause or permission sweep failed', err);
    } finally {
      this.budget.endRun();
      this.runActive = false;
      this.stalledRuns = this.progressMark() > before ? 0 : this.stalledRuns + 1;
      try {
        if (this.engine.hasWork()) await this.storage.setAlarm(this.deps.now() + this.nextRunDelayMs());
      } catch (err) {
        this.logger.error('alarm: could not re-arm', err);
      }
    }
  }

  // ------------------------------------------------------------------ HTTP

  private route(method: string, path: string, handler: Handler): void {
    const { pattern, keys } = compile(path);
    this.routes.push({ method, pattern, keys, handler });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const match = route.pattern.exec(url.pathname);
      if (match === null) continue;
      const params: RouteParams = {};
      try {
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1] ?? '');
        });
      } catch {
        return apiError(400, { code: API_ERROR_CODES.badRequest, message: 'Yêu cầu không hợp lệ.' });
      }
      try {
        return await route.handler(request, url, params);
      } catch (err) {
        return this.errorResponse(err);
      }
    }
    return apiError(404, { code: API_ERROR_CODES.notFound, message: 'Không tìm thấy đường dẫn.' });
  }

  /** Every error becomes { code, message }; stack traces, tokens and upstream objects never leave. */
  private errorResponse(error: unknown): Response {
    if (error instanceof HttpError) return apiError(error.statusCode, { code: error.code, message: error.message });
    if (isTransferError(error)) {
      return apiError(error.httpStatus, { code: error.code, message: redactSecrets(error.message) });
    }
    if (isProviderError(error)) {
      const { statusCode, body } = providerErrorToHttp(error);
      this.logger.warn(`provider error kind=${error.kind} status=${error.status ?? '-'} retryable=${error.retryable}`);
      return apiError(statusCode, body);
    }
    this.logger.error('unhandled error', error);
    return apiError(500, { code: API_ERROR_CODES.internal, message: 'Lỗi máy chủ nội bộ.' });
  }

  private requireAccount(id: string): void {
    if (!this.accounts.exists(id)) throw notFound('Không tìm thấy tài khoản này (có thể đã bị gỡ).');
  }

  private async readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      throw badRequest('Yêu cầu không hợp lệ.');
    }
  }

  private registerRoutes(): void {
    this.route('GET', API_PATHS.status, async () => json(this.status()));

    // ---------------------------------------------------------------- accounts
    this.route('GET', API_PATHS.accounts, async () => json({ accounts: this.accounts.list() }));

    this.route('DELETE', API_PATHS.account, async (_request, _url, params) => {
      const { id } = parseOrBadRequest(accountParamsSchema, params);
      this.requireAccount(id);
      const encrypted = this.accounts.getRefreshTokenEnc(id);
      // Local disconnect only: the row is removed, nothing in Google Drive is deleted or trashed.
      this.accounts.delete(id);
      this.registry.invalidate(id);
      if (encrypted !== null && this.oauthCredentials() !== null) {
        // Best effort, after the response: a failed revocation must not block the disconnect.
        const revoke = (async () => {
          const token = await (await this.getCipher()).decrypt(encrypted);
          await this.registry.nonInteractiveClient().revoke(token);
          this.logger.info(`revoked the Google token of removed account ${id}`);
        })().catch(() => this.logger.warn(`could not revoke the Google token of removed account ${id}`));
        this.waitUntil(revoke);
      }
      return json({ ok: true });
    });

    this.route('GET', API_PATHS.accountQuota, async (_request, _url, params) => {
      const { id } = parseOrBadRequest(accountParamsSchema, params);
      this.requireAccount(id);
      const provider = await this.registry.resolveProvider(id);
      return json({ quota: await provider.getQuota() });
    });

    this.route('GET', API_PATHS.accountFiles, async (_request, url, params) => {
      const { id } = parseOrBadRequest(accountParamsSchema, params);
      this.requireAccount(id);
      const query = parseOrBadRequest(listFilesQuerySchema, Object.fromEntries(url.searchParams));
      const provider = await this.registry.resolveProvider(id);
      return json(await provider.listFolder(query.folderId ?? ROOT_FOLDER_ID, query.pageToken));
    });

    this.route('GET', API_PATHS.accountFolderPath, async (_request, _url, params) => {
      const { id, folderId } = parseOrBadRequest(folderPathParamsSchema, params);
      this.requireAccount(id);
      const provider = await this.registry.resolveProvider(id);
      return json({ breadcrumbs: await buildBreadcrumbs(provider, folderId) });
    });

    // ---------------------------------------------------------------- OAuth
    this.route('GET', API_PATHS.authGoogleStart, async (_request, url) => {
      const credentials = this.oauthCredentials();
      if (credentials === null) throw notConfigured(this.missingConfig());
      await this.getCipher(); // refuses to start without a usable master key
      const { state, binding } = await this.states.issue();
      const client = this.deps.createOAuthClient({
        ...credentials,
        redirectUri: `${url.origin}${API_PATHS.authGoogleCallback}`,
        fetch: this.googleFetch,
        now: this.deps.now,
      });
      return redirect(client.buildAuthUrl(state), oauthCookie(url, binding, Math.floor(OAUTH_STATE_TTL_MS / 1000)));
    });

    this.route('GET', API_PATHS.authGoogleCallback, async (request, url) => {
      const query = parseOrBadRequest(authCallbackQuerySchema, Object.fromEntries(url.searchParams));
      const binding = readCookie(request, oauthCookieName(url));
      const clearCookie = oauthCookie(url, '', 0);
      const toWeb = (param: string, value: string): Response => {
        const target = new URL('/', url.origin);
        target.searchParams.set(param, value);
        return redirect(target.toString(), clearCookie);
      };

      // CSRF: the state is consumed on the first lookup and must match the cookie binding.
      const valid = await this.states.consume(query.state, binding);
      if (!valid) {
        const res = apiError(400, {
          code: API_ERROR_CODES.badRequest,
          message: 'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn. Hãy thử kết nối lại.',
        });
        res.headers.append('Set-Cookie', clearCookie);
        return res;
      }
      const credentials = this.oauthCredentials();
      if (credentials === null) throw notConfigured(this.missingConfig());

      if (query.error !== undefined) {
        return toWeb(AUTH_RESULT_PARAMS.error, query.error === 'access_denied' ? AUTH_ERROR_CODES.accessDenied : AUTH_ERROR_CODES.oauthError);
      }
      if (query.code === undefined) return toWeb(AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.missingCode);

      let cipher: TokenCipher;
      try {
        cipher = await this.getCipher();
      } catch {
        return toWeb(AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.storageUnavailable);
      }

      const client = this.deps.createOAuthClient({
        ...credentials,
        redirectUri: `${url.origin}${API_PATHS.authGoogleCallback}`,
        fetch: this.googleFetch,
        now: this.deps.now,
      });
      let exchanged;
      try {
        exchanged = await client.exchangeCode(query.code);
      } catch (err) {
        // Fixed fields only: never the error object or its message (it may echo request data).
        const kind = isProviderError(err) ? err.kind : 'unknown';
        this.logger.warn(`Google OAuth code exchange failed (kind=${kind})`);
        return toWeb(AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.tokenExchangeFailed);
      }
      if (!exchanged.driveScopeGranted) return toWeb(AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.driveScopeMissing);

      const { profile, refreshToken } = exchanged;
      if (refreshToken === null) {
        const existing = this.accounts.findByEmail('google-drive', profile.email);
        if (existing === undefined || this.accounts.getRefreshTokenEnc(existing.id) === null) {
          return toWeb(AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.noRefreshToken);
        }
      }
      let refreshTokenEnc: Uint8Array | null = null;
      if (refreshToken !== null) {
        try {
          refreshTokenEnc = await cipher.encrypt(refreshToken);
        } catch {
          return toWeb(AUTH_RESULT_PARAMS.error, AUTH_ERROR_CODES.storageUnavailable);
        }
      }
      const account = this.accounts.upsert({
        provider: 'google-drive',
        email: profile.email,
        displayName: profile.displayName,
        // The avatar is rendered as <img src>: https only (defence in depth, the client checks too).
        ...(isHttpsUrl(profile.avatarUrl) ? { avatarUrl: profile.avatarUrl } : {}),
        refreshTokenEnc,
      });
      this.registry.invalidate(account.id);
      this.logger.info(`Google account connected: ${account.id}`);
      // A (re)connected account may unblock work that waited for it: jobs paused on its auth error,
      // or a temporary share the permission sweep could not remove while its token was invalid.
      // One background run is cheap: it starts nothing when there is no work, then sweeps.
      await this.ensureAlarm();
      return toWeb(AUTH_RESULT_PARAMS.connected, account.id);
    });

    // ---------------------------------------------------------------- transfers
    // Creating, retrying or cancelling only writes state and schedules the alarm: transfer work
    // never runs inside a request.
    this.route('POST', API_PATHS.transfers, async (request) => {
      const status = this.status();
      if (!status.configured) throw notConfigured(status.missing);
      const body = parseOrBadRequest(createTransferSchema, await this.readJson(request));
      if (body.mode === 'move' && body.confirmMove !== true) {
        throw new HttpError(
          400,
          API_ERROR_CODES.moveNotConfirmed,
          'Thao tác di chuyển phải được xác nhận (confirmMove: true) vì tệp gốc sẽ bị chuyển vào thùng rác.',
        );
      }
      this.requireAccount(body.sourceAccountId);
      this.requireAccount(body.destAccountId);
      const req: CreateTransferRequest = {
        mode: body.mode,
        sourceAccountId: body.sourceAccountId,
        destAccountId: body.destAccountId,
        destFolderId: body.destFolderId,
        sourceFileIds: body.sourceFileIds,
        ...(body.confirmMove === true ? { confirmMove: true } : {}),
      };
      const job = await this.engine.createJob(req);
      await this.ensureAlarm();
      return json({ job }, 201);
    });

    this.route('GET', API_PATHS.transfers, async () => json({ jobs: this.engine.listJobs() }));

    this.route('GET', API_PATHS.transfer, async (_request, _url, params) => {
      const { id } = parseOrBadRequest(jobParamsSchema, params);
      const job = this.engine.getJob(id);
      if (job === undefined) throw notFound('Không tìm thấy tác vụ chuyển tệp này.');
      return json({ job });
    });

    this.route('POST', API_PATHS.transferCancel, async (_request, _url, params) => {
      const { id } = parseOrBadRequest(jobParamsSchema, params);
      const current = this.engine.getJob(id);
      if (current === undefined) throw notFound('Không tìm thấy tác vụ chuyển tệp này.');
      if (isTerminalJobStatus(current.status)) return json({ job: current });
      // A queued job is finalised at once (state only). A running job is aborted; its cleanup
      // finishes inside the alarm run that owns it, the response does not wait beyond the grace.
      const canceling = this.engine.cancel(id).then(
        () => undefined,
        () => this.logger.warn(`cancel of transfer job ${id} failed`),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        canceling,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.deps.timing.cancelGraceMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      this.waitUntil(canceling);
      if (this.engine.hasWork()) await this.ensureAlarm();
      const job = this.engine.getJob(id);
      if (job === undefined) throw notFound('Không tìm thấy tác vụ chuyển tệp này.');
      return json({ job });
    });

    this.route('POST', API_PATHS.transferRetryFailed, async (_request, _url, params) => {
      const { id } = parseOrBadRequest(jobParamsSchema, params);
      const job = await this.engine.retryFailed(id);
      if (this.engine.hasWork()) await this.ensureAlarm();
      return json({ job });
    });

    // Explicit, separately confirmed PERMANENT delete of the originals a finished move job trashed.
    // Bounded batch per request (a few subrequests per item); the client calls again while
    // `remaining` > 0.
    this.route('POST', API_PATHS.transferPurgeTrashed, async (request, _url, params) => {
      const { id } = parseOrBadRequest(jobParamsSchema, params);
      const body = parseOrBadRequest(purgeTrashedSchema, await this.readJson(request));
      if (body.confirmPermanentDelete !== true) {
        throw new HttpError(400, API_ERROR_CODES.purgeNotConfirmed, 'Xóa vĩnh viễn phải được xác nhận rõ ràng (confirmPermanentDelete: true) vì không thể hoàn tác.');
      }
      if (this.engine.getJob(id) === undefined) throw notFound('Không tìm thấy tác vụ chuyển tệp này.');
      return json(await this.engine.purgeTrashedSources(id, { maxItems: PURGE_BATCH_PER_REQUEST }));
    });

    // ---------------------------------------------------------------- events
    this.route('GET', API_PATHS.events, async () => createSseResponse(this.engine, this.deps.sse));
  }
}
