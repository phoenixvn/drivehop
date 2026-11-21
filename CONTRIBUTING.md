# Contributing to DriveHop

Thanks for helping! Small, focused pull requests are easiest to review.

## Setup

```bash
git clone https://github.com/phoenixvn/drivehop.git
cd drivehop
npm install
npm run dev            # http://localhost:5173 (add ?mock=1 to try the UI without Google)
```

Node.js ≥ 22.12 is required. The layout:

- `packages/shared`: API types shared by the server and the web UI
- `packages/core`: the transfer engine (Google Drive API v3)
- `apps/server`: local Fastify server and the Windows app entry point (`src/desktop.ts`)
- `apps/web`: React UI
- `apps/worker`: Cloudflare Worker + Durable Object

## Before you open a PR

```bash
npm run typecheck
npm test
```

- Never commit `.env`, `.dev.vars`, `apps/worker/wrangler.jsonc`, tokens, real emails or private file names (also not in tests or screenshots: use mock mode).
- Docs come in English (`README.md`) and Vietnamese (`README.vi.md`); keep both in sync when you change one.

## Building the Windows app

`npm run build:desktop` (on Windows x64) writes `release/DriveHop-win-x64/` and a zip.
