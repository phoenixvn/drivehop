import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SetupInfo } from '@multicloud/shared';
import dotenv from 'dotenv';

/** Absolute path of the repository root (this file lives in apps/server/src). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DEFAULT_PORT = 8787;
export const DEFAULT_WEB_ORIGIN = 'http://localhost:5173';
export const DEFAULT_DATA_DIR = './data';
/**
 * File in the data directory where the web UI's setup form saves the Google OAuth client
 * (dotenv format). Lowest precedence: process env and the repo-root `.env` win over it.
 */
export const SETTINGS_FILE_NAME = 'config.env';

/** Environment variables that must be set before any Google call can be made. */
export const REQUIRED_GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;

export interface AppConfig {
  /** `null` when GOOGLE_CLIENT_ID is missing or empty. */
  googleClientId: string | null;
  /** `null` when GOOGLE_CLIENT_SECRET is missing or empty. Never log this value. */
  googleClientSecret: string | null;
  port: number;
  /** Origin of the web UI (scheme + host + port, no path). CORS and post-login redirect target. */
  webOrigin: string;
  /** Absolute path. */
  dataDir: string;
  /** Raw MULTICLOUD_MASTER_KEY (base64) or `null`. Never log this value. */
  masterKeyBase64: string | null;
  /** http://localhost:<port>/api/auth/google/callback */
  redirectUri: string;
  /** Absolute path of the settings file written by POST /api/setup (in dataDir). */
  settingsFile: string;
  /**
   * Absolute path of the built web UI to serve on the API port (the packaged app), or `null` when
   * the UI is served separately (Vite dev server). From WEB_DIST.
   */
  webDist: string | null;
}

/** Shape returned by GET /api/status (identical to StatusResponse of the shared contract). */
export interface ConfigStatus {
  configured: boolean;
  missing: string[];
  keyringAvailable: boolean;
  setup?: SetupInfo;
}

export interface LoadConfigOptions {
  /** Defaults to `process.env`. Values here win over the `.env` file. */
  env?: Record<string, string | undefined>;
  /** Path of the `.env` file. Defaults to `<repo root>/.env`. Pass `null` to skip reading a file. */
  envFile?: string | null;
  /** Pass `null` to ignore `<dataDir>/config.env`. Also ignored when `envFile` is `null`. */
  settingsFile?: null;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads configuration from the process environment and the repo-root `.env` file (the process
 * environment wins). Never throws because Google credentials are missing: the server must boot
 * without them. It does throw for values that are present but malformed (PORT, WEB_ORIGIN).
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const processEnv = options.env ?? process.env;
  // The packaged app (DRIVEHOP_DESKTOP=1) has no repository: no `.env`, only the settings file.
  const isDesktop = processEnv.DRIVEHOP_DESKTOP === '1';
  const envFile = options.envFile === undefined ? path.join(REPO_ROOT, '.env') : options.envFile;

  let fileEnv: Record<string, string> = {};
  if (envFile !== null && !(isDesktop && options.envFile === undefined) && existsSync(envFile)) {
    fileEnv = dotenv.parse(readFileSync(envFile));
  }
  const read = (name: string): string | null => nonEmpty(processEnv[name]) ?? nonEmpty(fileEnv[name]);

  const portRaw = read('PORT');
  let port = DEFAULT_PORT;
  if (portRaw !== null) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid PORT: expected an integer between 1 and 65535`);
    }
  }

  const webOriginRaw = read('WEB_ORIGIN') ?? DEFAULT_WEB_ORIGIN;
  let webOrigin: string;
  try {
    const url = new URL(webOriginRaw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported scheme');
    webOrigin = url.origin;
  } catch {
    throw new Error('Invalid WEB_ORIGIN: expected an http(s) origin such as http://localhost:5173');
  }

  const dataDir = path.resolve(REPO_ROOT, read('DATA_DIR') ?? DEFAULT_DATA_DIR);
  const settingsFile = path.join(dataDir, SETTINGS_FILE_NAME);
  let settingsEnv: Record<string, string> = {};
  // Hermetic callers (tests) pass envFile: null; they never read the settings file either.
  if (options.settingsFile !== null && envFile !== null && existsSync(settingsFile)) {
    settingsEnv = dotenv.parse(readFileSync(settingsFile));
  }
  const readGoogle = (name: string): string | null => read(name) ?? nonEmpty(settingsEnv[name]);
  const webDistRaw = read('WEB_DIST');

  return {
    googleClientId: readGoogle('GOOGLE_CLIENT_ID'),
    googleClientSecret: readGoogle('GOOGLE_CLIENT_SECRET'),
    port,
    webOrigin,
    dataDir,
    masterKeyBase64: read('MULTICLOUD_MASTER_KEY'),
    redirectUri: `http://localhost:${port}/api/auth/google/callback`,
    settingsFile,
    webDist: webDistRaw === null ? null : path.resolve(REPO_ROOT, webDistRaw),
  };
}

/** Names of the required Google variables that are not set. */
export function missingGoogleVars(config: AppConfig): string[] {
  const missing: string[] = [];
  if (config.googleClientId === null) missing.push('GOOGLE_CLIENT_ID');
  if (config.googleClientSecret === null) missing.push('GOOGLE_CLIENT_SECRET');
  return missing;
}

export function buildStatus(config: AppConfig, keyringAvailable: boolean): ConfigStatus {
  const missing = missingGoogleVars(config);
  return { configured: missing.length === 0, missing, keyringAvailable };
}
