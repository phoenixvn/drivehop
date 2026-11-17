import type { MultiCloudCore } from './index.ts';

/**
 * Bindings and variables of the Worker.
 *
 * - vars (wrangler.jsonc, empty until the owner fills them; the Worker fails closed while empty):
 *   ACCESS_TEAM_DOMAIN, ACCESS_AUD
 * - secrets (`wrangler secret put`, never in a file): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *   MULTICLOUD_MASTER_KEY (base64 of 32 random bytes)
 * - LOCAL ONLY (.dev.vars, never in wrangler.jsonc or a deployed environment): DEV_AUTH_BYPASS
 */
export interface WorkerEnv {
  CORE: DurableObjectNamespace<MultiCloudCore>;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MULTICLOUD_MASTER_KEY?: string;
  DEV_AUTH_BYPASS?: string;
}

/** Name of the singleton Durable Object that owns accounts, OAuth state, jobs and the engine. */
export const CORE_OBJECT_NAME = 'core';
