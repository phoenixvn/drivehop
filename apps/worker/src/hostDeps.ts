// Injectable dependencies of the Durable Object host. Production uses the core Google client and
// cipher; tests replace them (FakeProvider, a fake OAuth client, a reversible fake cipher) through
// setHostDepsForTesting() BEFORE the object is constructed. Nothing reachable from an HTTP request
// can call the setter.
import { createGoogleDriveProvider, createGoogleOAuthClient, createTokenCipher } from '@multicloud/core';
import type {
  GoogleDriveProviderOptions,
  GoogleOAuthClient,
  GoogleOAuthClientOptions,
  TokenCipher,
  TransferEngineOptions,
} from '@multicloud/core';
import type { CloudProvider } from '@multicloud/shared';
import type { WorkerEnv } from './env.ts';
import type { SseStreamOptions } from './sse.ts';

export interface HostTiming {
  /** Wall-clock budget of one alarm run (alarm handlers may run at most 15 minutes). */
  runBudgetMs: number;
  /** Delay of the next alarm while work remains. */
  reArmDelayMs: number;
  /** Delay of the alarm set by a request (create / retry / cancel) or by the constructor. */
  startDelayMs: number;
  /** How often a run checks whether its subrequest budget is spent. */
  budgetCheckMs: number;
  /** Subrequests one alarm run may use for transfer work (see wrangler.jsonc limits.subrequests). */
  subrequestBudget: number;
  /** No new item starts with fewer than this many subrequests left (largest single item). */
  subrequestSafetyMargin: number;
  /** POST .../cancel waits this long for a running job before answering. */
  cancelGraceMs: number;
}

export interface HostDeps {
  createOAuthClient: (options: GoogleOAuthClientOptions) => GoogleOAuthClient;
  createDriveProvider: (options: GoogleDriveProviderOptions) => CloudProvider;
  createCipher: (masterKey: string) => Promise<TokenCipher>;
  /** Base fetch for Google subrequests (wrapped by the subrequest counter). */
  fetch: typeof fetch;
  now: () => number;
  timing: HostTiming;
  /** Extra engine options (tests: progressThrottleMs, sleep). */
  engineOptions?: TransferEngineOptions;
  sse?: SseStreamOptions;
  /** Tests only: values layered over the runtime env of the object (fake credentials). */
  envOverride?: Partial<Pick<WorkerEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'MULTICLOUD_MASTER_KEY'>>;
}

export const DEFAULT_TIMING: HostTiming = {
  // 10 minutes: well below the documented 15-minute wall-time cap of an alarm handler, leaving
  // room for pause() (in-flight calls finish), the permission sweep and re-arming.
  runBudgetMs: 10 * 60_000,
  reArmDelayMs: 1_000,
  startDelayMs: 0,
  budgetCheckMs: 1_000,
  // wrangler.jsonc sets limits.subrequests = 8000; 500 stay free for token refreshes, the
  // permission sweep after pause() and calls that were already in flight.
  subrequestBudget: 7_500,
  // A stream-fallback file of MAX_STREAM_BYTES needs 256 upload chunks + a few metadata calls.
  subrequestSafetyMargin: 300,
  cancelGraceMs: 300,
};

export function defaultHostDeps(): HostDeps {
  return {
    createOAuthClient: createGoogleOAuthClient,
    createDriveProvider: createGoogleDriveProvider,
    createCipher: (key) => createTokenCipher(key),
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
    timing: DEFAULT_TIMING,
  };
}

let override: Partial<HostDeps> | null = null;

/** Test hook: replaces parts of the dependencies of objects constructed afterwards. */
export function setHostDepsForTesting(deps: Partial<HostDeps> | null): void {
  override = deps;
}

export function resolveHostDeps(): HostDeps {
  const base = defaultHostDeps();
  if (override === null) return base;
  return { ...base, ...override, timing: { ...base.timing, ...override.timing } };
}
