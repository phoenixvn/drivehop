import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// One source of truth with the server: the repo-root .env (shell variables win over it).
// WEB_ORIGIN decides the dev-server port, PORT decides where /api is proxied.
const rootEnv = loadEnv('development', fileURLToPath(new URL('../..', import.meta.url)), '');
const setting = (name: string): string | undefined => process.env[name] || rootEnv[name] || undefined;

function webPort(): number {
  const origin = setting('WEB_ORIGIN');
  if (!origin) return 5173;
  const url = new URL(origin);
  if (url.hostname !== 'localhost' || !url.port) {
    throw new Error(`WEB_ORIGIN must look like http://localhost:<port>, got "${origin}"`);
  }
  return Number(url.port);
}

const API_TARGET = setting('VITE_API_TARGET') ?? `http://localhost:${setting('PORT') ?? '8787'}`;

export default defineConfig({
  plugins: [react()],
  // Served from the site root (same origin as /api), so asset URLs are absolute ('/assets/...') and
  // index.html works as the single-page-application fallback for any path.
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  },
  server: {
    port: webPort(),
    strictPort: true,
    // By default the dev server serves EVERY file under the npm-workspace root (/@fs/...), which
    // includes ./data (the SQLite database) and the server sources. Serve only what the UI needs.
    fs: {
      strict: true,
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../../packages', import.meta.url)),
        fileURLToPath(new URL('../../node_modules', import.meta.url)),
      ],
      // Replaces Vite's default deny list, so its entries are repeated here.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '**/*.sqlite*'],
    },
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
        // No `timeout` / `proxyTimeout`: an idle SSE connection (GET /api/events) must stay open.
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Ask the API for an uncompressed event stream so chunks pass through untouched.
            if (req.headers.accept?.includes('text/event-stream')) {
              proxyReq.setHeader('accept-encoding', 'identity');
            }
          });
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            const contentType = String(proxyRes.headers['content-type'] ?? '');
            if (!contentType.includes('text/event-stream')) return;
            // Server-sent events: forward every chunk immediately, never buffer or transform.
            proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            proxyRes.headers['x-accel-buffering'] = 'no';
            res.socket?.setNoDelay(true);
          });
        },
      },
    },
  },
});
