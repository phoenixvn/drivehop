import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from './config.ts';
import { runServer } from './run.ts';

/**
 * Entry of the packaged Windows app (DriveHop.exe, see scripts/build-desktop.mjs). Same server as
 * `npm run dev`, but it also serves the built web UI on its own port, keeps its data in the user's
 * profile and opens the browser. Every default below can still be overridden by the environment.
 */
const exeDir = path.dirname(process.execPath);
const defaults: Record<string, string> = {
  DRIVEHOP_DESKTOP: '1',
  DATA_DIR: path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'DriveHop', 'data'),
  WEB_DIST: path.join(exeDir, 'app', 'web'),
};
for (const [name, value] of Object.entries(defaults)) {
  if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
}
const port = process.env.PORT !== undefined && process.env.PORT !== '' ? process.env.PORT : String(DEFAULT_PORT);
if (process.env.WEB_ORIGIN === undefined || process.env.WEB_ORIGIN === '') {
  process.env.WEB_ORIGIN = `http://localhost:${port}`;
}
process.title = 'DriveHop';

console.log('DriveHop is running. Keep this window open while you use it; close it to quit.\n(DriveHop đang chạy. Giữ cửa sổ này mở trong lúc dùng; đóng nó để tắt.)');
console.log(`Data: ${process.env.DATA_DIR}`);

runServer({ openBrowser: process.env.DRIVEHOP_NO_BROWSER !== '1' }).catch((err: unknown) => {
  console.error(`DriveHop could not start: ${err instanceof Error ? err.message : 'unknown error'}`);
  // Keep the console window open long enough to read the message.
  setTimeout(() => process.exit(1), 30_000);
});
