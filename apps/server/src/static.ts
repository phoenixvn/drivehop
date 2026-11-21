import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Serves the built web UI (apps/web/dist) on the API port, for the packaged desktop app where no
 * Vite dev server runs. Unknown paths fall back to index.html (single-page app). Never serves
 * anything outside `root`.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Same policy as the Cloudflare Worker (apps/worker/src/gate.ts), minus HSTS (plain http here). */
export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Resolves a URL path to a file under `root`, or `null` (missing, a folder, or outside root). */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) return null;
  return isFile(candidate) ? candidate : null;
}

/** True when `root` looks like a built web UI. */
export function hasWebBuild(root: string): boolean {
  return existsSync(path.join(root, 'index.html'));
}

/**
 * Answers a GET/HEAD for a non-API path. Returns false when the request is not for the UI
 * (the caller then answers 404 as usual).
 */
export function serveWebUi(root: string, request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const urlPath = request.url.split('?')[0] ?? '/';
  if (urlPath === '/api' || urlPath.startsWith('/api/')) return false;

  const file = resolveStaticPath(root, urlPath) ?? path.join(path.resolve(root), 'index.html');
  if (!isFile(file)) return false;

  const isIndex = path.basename(file) === 'index.html';
  const isHashedAsset = !isIndex && urlPath.startsWith('/assets/');
  reply.headers(STATIC_SECURITY_HEADERS);
  reply.header('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  reply.header('Cache-Control', isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
  reply.status(200);
  if (request.method === 'HEAD') {
    void reply.send();
  } else {
    void reply.send(createReadStream(file));
  }
  return true;
}
