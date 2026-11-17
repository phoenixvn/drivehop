// MultiCloud on Cloudflare: ONE Worker (static web UI + /api/*) and ONE SQLite-backed Durable
// Object (singleton 'core') that owns accounts, OAuth state, jobs and the transfer engine.
//
// Every request, static assets included (assets.run_worker_first = true), passes the Access check
// first; /api/* is then CSRF-checked and forwarded to the object.
import { DurableObject } from 'cloudflare:workers';
import { AccessVerifier } from './access.ts';
import type { JwksFetcher } from './access.ts';
import { CORE_OBJECT_NAME } from './env.ts';
import type { WorkerEnv } from './env.ts';
import { authenticate, checkCsrf, withSecurityHeaders } from './gate.ts';
import { CoreHost } from './host.ts';
import { resolveHostDeps } from './hostDeps.ts';

export class MultiCloudCore extends DurableObject<WorkerEnv> {
  readonly host: CoreHost;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    const deps = resolveHostDeps();
    this.host = new CoreHost({
      storage: ctx.storage,
      env: deps.envOverride === undefined ? env : { ...env, ...deps.envOverride },
      deps,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
    // Unfinished jobs were re-queued by the engine (manual mode): make sure an alarm resumes them.
    void ctx.blockConcurrencyWhile(() => this.host.resumeIfNeeded());
  }

  override async fetch(request: Request): Promise<Response> {
    return this.host.handle(request);
  }

  override async alarm(): Promise<void> {
    await this.host.runAlarm();
  }
}

export interface WorkerHandlerOptions {
  /** JWKS fetch (tests stub the Access key endpoint). */
  fetchJwks?: JwksFetcher;
  now?: () => number;
}

export function createWorkerHandler(options: WorkerHandlerOptions = {}): ExportedHandler<WorkerEnv> {
  // One verifier per isolate: it caches the team's signing keys.
  const verifier = new AccessVerifier({
    ...(options.fetchJwks === undefined ? {} : { fetchJwks: options.fetchJwks }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const route = async (request: Request, env: WorkerEnv): Promise<Response> => {
    const refused = await authenticate(request, env, verifier);
    if (refused !== null) return refused;

    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const csrf = checkCsrf(request);
      if (csrf !== null) return csrf;
      const stub = env.CORE.get(env.CORE.idFromName(CORE_OBJECT_NAME));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  };
  return {
    async fetch(request, env): Promise<Response> {
      return withSecurityHeaders(await route(request, env));
    },
  };
}

export default createWorkerHandler();
