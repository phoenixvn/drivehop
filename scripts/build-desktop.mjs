#!/usr/bin/env node
// Builds the portable Windows app: release/DriveHop-win-x64/ and release/DriveHop-win-x64-v<version>.zip
//
//   DriveHop.exe        Node single executable application (SEA) running apps/server/src/desktop.ts
//   app/web/            the built web UI, served on http://localhost:8787
//   app/node_modules/   the two native modules (better-sqlite3, @napi-rs/keyring) that cannot live
//                       inside the exe; the bundle loads them from here (see BANNER)
//   LICENSE, THIRD_PARTY_NOTICES.txt, README.txt
//
// Usage (Windows x64, Node >= 22.12): npm run build:desktop
// Everything copied into the release folder comes from an allowlist; nothing else from the
// repository (no .env, no data, no source maps) ends up in it.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as ResEdit from 'resedit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const RELEASE = path.join(ROOT, 'release');
const WORK = path.join(RELEASE, '.work');
const OUT_NAME = 'DriveHop-win-x64';
const OUT = path.join(RELEASE, OUT_NAME);
const ZIP = path.join(RELEASE, `${OUT_NAME}-v${VERSION}.zip`);
const NM = path.join(ROOT, 'node_modules');

/** Native packages shipped next to the exe, with the files each one needs at runtime. */
const NATIVE_PACKAGES = {
  'better-sqlite3': ['package.json', 'LICENSE', 'lib', 'prebuilds/win32-x64.node'],
  '@napi-rs/keyring': ['package.json', 'LICENSE', 'index.js'],
  '@napi-rs/keyring-win32-x64-msvc': ['package.json', 'LICENSE.third-party.md', 'keyring.win32-x64-msvc.node'],
};

// Inside the SEA, `require` only knows Node built-ins. Redirect it to a real require rooted next
// to the exe (app/main.js) so the native packages above resolve from app/node_modules.
const BANNER = `var require = (function (r) {
  try {
    if (r('node:sea').isSea()) {
      var p = r('node:path');
      return r('node:module').createRequire(p.join(p.dirname(process.execPath), 'app', 'main.js'));
    }
  } catch (e) {}
  return r;
})(require);
var __drivehop_import_meta_url = require('node:url').pathToFileURL(process.execPath).href;`;

/**
 * Gives the copied node.exe DriveHop's icon and version info (what Explorer, the taskbar and
 * SmartScreen show). Must run before postject injects the app blob.
 */
function brandExe(file) {
  const exe = ResEdit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(readFileSync(path.join(ROOT, 'docs', 'brand', 'drivehop.ico')));
  const group = res.entries.find((entry) => entry.type === 14);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    group?.id ?? 1,
    group?.lang ?? 1033,
    icon.icons.map((item) => item.data),
  );
  const info = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [major, minor, patch] = VERSION.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  info.setFileVersion(major, minor, patch, 0, 1033);
  info.setProductVersion(major, minor, patch, 0, 1033);
  for (const lang of info.getAllLanguagesForStringValues()) {
    info.setStringValues(lang, {
      CompanyName: 'DriveHop contributors',
      ProductName: 'DriveHop',
      FileDescription: 'DriveHop - move files between your Google Drive accounts',
      FileVersion: VERSION,
      ProductVersion: VERSION,
      OriginalFilename: 'DriveHop.exe',
      InternalName: 'DriveHop',
      LegalCopyright: `MIT License. Includes Node.js ${process.version} (MIT).`,
    });
  }
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
}

function step(message) {
  console.log(`\n== ${message}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...options });
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('build-desktop: run this on Windows x64 (the exe embeds the Node binary running the build).');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
rmSync(ZIP, { force: true });
mkdirSync(path.join(OUT, 'app'), { recursive: true });
mkdirSync(WORK, { recursive: true });

step('Building the web UI');
run('npm', ['run', 'build', '-w', '@multicloud/web']);
cpSync(path.join(ROOT, 'apps', 'web', 'dist'), path.join(OUT, 'app', 'web'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

step('Bundling the server');
const bundlePath = path.join(WORK, 'main.cjs');
const result = await build({
  entryPoints: [path.join(ROOT, 'apps', 'server', 'src', 'desktop.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // import('@napi-rs/keyring') must go through the redirected require (see BANNER).
  supported: { 'dynamic-import': false },
  external: Object.keys(NATIVE_PACKAGES),
  define: { 'import.meta.url': '__drivehop_import_meta_url' },
  banner: { js: BANNER },
  legalComments: 'none',
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
});

step('Creating DriveHop.exe (Node single executable application)');
const seaConfig = path.join(WORK, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundlePath, output: path.join(WORK, 'sea-prep.blob'), disableExperimentalSEAWarning: true }),
);
run(process.execPath, ['--experimental-sea-config', seaConfig], { shell: false });
const exe = path.join(OUT, 'DriveHop.exe');
cpSync(process.execPath, exe);
brandExe(exe);
run(
  process.execPath,
  [
    path.join(NM, 'postject', 'dist', 'cli.js'),
    exe,
    'NODE_SEA_BLOB',
    path.join(WORK, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { shell: false },
);

step('Copying native modules');
for (const [name, files] of Object.entries(NATIVE_PACKAGES)) {
  for (const file of files) {
    const from = path.join(NM, name, file);
    if (!existsSync(from)) throw new Error(`missing ${name}/${file}: run npm install first`);
    cpSync(from, path.join(OUT, 'app', 'node_modules', name, file), { recursive: true });
  }
}

step('Writing licences and README');
cpSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE.txt'));
const notices = [];
const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
if (existsSync(nodeLicense)) {
  notices.push(`=== Node.js ${process.version} (embedded in DriveHop.exe) ===\n\n${readFileSync(nodeLicense, 'utf8')}`);
}
const bundled = new Set(Object.keys(NATIVE_PACKAGES));
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
  if (match) bundled.add(match[1].replace(/\\/g, '/'));
}
// The web UI (app/web) bundles its runtime dependencies too (React, the Inter font, ...).
const webPkg = JSON.parse(readFileSync(path.join(ROOT, 'apps', 'web', 'package.json'), 'utf8'));
for (const name of Object.keys(webPkg.dependencies ?? {})) {
  if (!name.startsWith('@multicloud/')) bundled.add(name);
}
for (const name of [...bundled].sort()) {
  const dir = path.join(NM, ...name.split('/'));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'LICENSE.third-party.md']
    .map((file) => path.join(dir, file))
    .find((file) => existsSync(file));
  const text = licenseFile ? readFileSync(licenseFile, 'utf8') : `License: ${pkg.license ?? 'see package'}`;
  notices.push(`=== ${name}@${pkg.version} (${pkg.license ?? 'unknown'}) ===\n\n${text}`);
}
writeFileSync(path.join(OUT, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
writeFileSync(
  path.join(OUT, 'README.txt'),
  `DriveHop ${VERSION} for Windows (x64)

1. Double-click DriveHop.exe. A console window opens and your browser shows http://localhost:8787
   (Windows SmartScreen may warn that the app is unrecognized: More info -> Run anyway).
2. First run: follow the setup screen to create your own Google OAuth client (free, ~10 minutes).
3. Keep the console window open while you use DriveHop. Close it to quit.

Your data (linked accounts, transfer jobs) is stored in %LOCALAPPDATA%\\DriveHop\\data.
Refresh tokens are encrypted with a key kept in Windows Credential Manager.

https://github.com/phoenixvn/drivehop

---

Nhấp đúp DriveHop.exe, trình duyệt sẽ mở http://localhost:8787. Lần đầu, làm theo màn hình thiết
lập để tạo OAuth client Google của riêng bạn. Giữ cửa sổ đen mở trong lúc dùng; đóng nó để tắt.
`.replace(/\n/g, '\r\n'),
);

step('Zipping');
run('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${OUT}' -DestinationPath '${ZIP}' -Force`,
]);

rmSync(WORK, { recursive: true, force: true });
console.log(`\nDone:\n  ${OUT}\n  ${ZIP}`);
