import { spawn } from 'node:child_process';
import net from 'node:net';
import { LISTEN_HOST, buildServer } from './app.ts';
import type { BuiltServer } from './app.ts';
import { loadConfig } from './config.ts';

export interface RunServerOptions {
  /** Open the web UI in the default browser once the server listens (packaged desktop app). */
  openBrowser?: boolean;
}

function message(err: unknown): string {
  // Message only: never dump error objects, they may reference configuration values.
  return err instanceof Error ? err.message : 'unknown error';
}

/** True when nothing listens on LISTEN_HOST:port yet. Checked BEFORE building the server, so a
 * second copy of the app never opens the database or resumes jobs next to the first one. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: LISTEN_HOST, port }, () => probe.close(() => resolve(true)));
  });
}

/** Opens `url` in the default browser (Windows `start`, macOS `open`, else `xdg-open`). */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      // cmd needs the empty window title as a literal "" (Node would escape it otherwise).
      windowsVerbatimArguments: process.platform === 'win32',
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed in the console as well.
  }
}

/**
 * Starts the local server. Saving the Google OAuth client from the setup screen closes the
 * running server and builds a new one with the new configuration (same port, same process).
 */
export async function runServer(options: RunServerOptions = {}): Promise<void> {
  const port = loadConfig().port;
  let current: BuiltServer | null = null;
  let restarting = false;

  const start = async (): Promise<BuiltServer> => {
    const built = await buildServer({ onSetupSaved: () => void restart() });
    await built.app.listen({ host: LISTEN_HOST, port: built.config.port });
    current = built;
    return built;
  };

  const restart = async (): Promise<void> => {
    if (restarting) return;
    restarting = true;
    try {
      await current?.app.close();
      current = null;
      const built = await start();
      built.app.log.info('Server restarted with the new configuration.');
    } catch (err) {
      console.error(`DriveHop failed to restart: ${message(err)}`);
      process.exit(1);
    } finally {
      restarting = false;
    }
  };

  const shutdown = (): void => {
    const closing = current?.app.close() ?? Promise.resolve();
    closing.then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const uiUrl = (built: BuiltServer): string =>
    built.config.webDist !== null ? `http://localhost:${built.config.port}/` : built.config.webOrigin;

  if (!(await portIsFree(port))) {
    const url = `http://localhost:${port}/`;
    if (options.openBrowser) {
      // Most likely DriveHop is already running (double-clicked twice): show it instead.
      console.log(`Port ${port} is already in use; DriveHop is probably running already. Opening ${url} ...`);
      openInBrowser(url);
      return;
    }
    throw new Error(`Port ${port} is already in use (set PORT to use another one).`);
  }

  const built = await start();
  built.app.log.info(`DriveHop server ready on http://${LISTEN_HOST}:${built.config.port} (web UI: ${uiUrl(built)})`);
  if (options.openBrowser) openInBrowser(uiUrl(built));
}
