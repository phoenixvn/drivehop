import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { API_PATHS } from '@multicloud/shared';
import type { SetupResponse } from '@multicloud/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import type { AccountsRepo } from '../db/accounts.ts';
import { HttpError, badRequest } from '../errors.ts';

/**
 * Google client IDs look like `<digits>-<random>.apps.googleusercontent.com`; secrets like
 * `GOCSPX-<random>`. Both are restricted to characters that need no quoting in the dotenv file
 * (no whitespace, newlines, quotes, `#` or `$`).
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9._~-]{8,200}$/;

const setupSchema = z.object({
  clientId: z.string().trim().regex(CLIENT_ID_PATTERN, 'invalid client id'),
  clientSecret: z.string().trim().regex(CLIENT_SECRET_PATTERN, 'invalid client secret'),
});

export interface SetupRouteDeps {
  config: AppConfig;
  accounts: AccountsRepo;
  /** Called once the settings file is written and the response is sent: rebuilds the server. */
  onSetupSaved: () => void;
}

/** Writes the settings file atomically (temp file + rename). */
export function writeSettingsFile(settingsFile: string, clientId: string, clientSecret: string): void {
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  const body =
    '# Written by the DriveHop setup screen. Delete this file to set the Google client again.\n' +
    `GOOGLE_CLIENT_ID=${clientId}\n` +
    `GOOGLE_CLIENT_SECRET=${clientSecret}\n`;
  const temp = `${settingsFile}.tmp`;
  writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, settingsFile);
}

/**
 * POST /api/setup: saves the Google OAuth client from the web UI, then restarts the server so the
 * new client is used. Refused once an account is linked: refresh tokens belong to the client that
 * issued them, so changing it would silently break every linked account.
 */
export const setupRoutes: FastifyPluginAsync<SetupRouteDeps> = async (app, deps) => {
  app.post(API_PATHS.setup, async (request, reply): Promise<SetupResponse> => {
    if (deps.accounts.list().length > 0) {
      throw new HttpError(
        409,
        'conflict',
        'Đã có tài khoản được liên kết. Đổi OAuth client sẽ làm hỏng các tài khoản đó, nên không đổi từ giao diện được.',
      );
    }
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      // Never echo the submitted values: the secret must not come back in a response or a log.
      throw badRequest(
        'Client ID phải có dạng …apps.googleusercontent.com, client secret phải dài ít nhất 8 ký tự và không chứa khoảng trắng.',
      );
    }
    const body = parsed.data;
    writeSettingsFile(deps.config.settingsFile, body.clientId, body.clientSecret);
    request.log.info('Google OAuth client saved from the setup screen; restarting');
    reply.raw.once('finish', () => {
      setTimeout(deps.onSetupSaved, 50);
    });
    return { ok: true };
  });
};
