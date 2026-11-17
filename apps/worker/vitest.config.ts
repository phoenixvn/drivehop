import { existsSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd (the Workers runtime) with the bindings of wrangler.jsonc.
// wrangler.jsonc is your own, git-ignored copy of wrangler.example.jsonc; a fresh clone
// falls back to the template.
const configPath = existsSync('./wrangler.jsonc') ? './wrangler.jsonc' : './wrangler.example.jsonc';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath } })],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
