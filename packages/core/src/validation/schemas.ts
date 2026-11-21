// Host-independent request validation (zod only, no Fastify): shared by the Node server and the Worker.
import { z } from 'zod';
import { badRequest } from '../http/errors.ts';

/** Drive file / folder ids, and the 'root' alias. */
export const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PAGE_TOKEN_LENGTH = 2048;
export const MAX_SOURCE_FILE_IDS = 500;

export const fileIdSchema = z.string().regex(FILE_ID_PATTERN, 'invalid file or folder id');
export const pageTokenSchema = z.string().min(1).max(MAX_PAGE_TOKEN_LENGTH);

/** Format check only; whether the account exists is a separate question (404). */
export const accountIdSchema = z.string().regex(ACCOUNT_ID_PATTERN, 'invalid account id');

/** Params of /api/accounts/:id and its sub-routes. */
export const accountParamsSchema = z.object({ id: accountIdSchema });

/** Params of GET /api/accounts/:id/folders/:folderId/path */
export const folderPathParamsSchema = z.object({ id: accountIdSchema, folderId: fileIdSchema });

/** Query of GET /api/accounts/:id/files */
export const listFilesQuerySchema = z.object({
  folderId: fileIdSchema.optional(),
  pageToken: pageTokenSchema.optional(),
});

/** Query Google sends to GET /api/auth/google/callback */
export const authCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().min(1).max(256).optional(),
});

/** Body of POST /api/transfers */
export const createTransferSchema = z.object({
  mode: z.enum(['copy', 'move']),
  sourceAccountId: accountIdSchema,
  destAccountId: accountIdSchema,
  destFolderId: fileIdSchema,
  sourceFileIds: z
    .array(fileIdSchema)
    .min(1)
    .max(MAX_SOURCE_FILE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate file ids'),
  // Only the boolean `true` confirms a move; any other value is simply "not confirmed".
  confirmMove: z.unknown().optional(),
});

/** Body of POST /api/transfers/:id/purge-trashed. Only the boolean `true` confirms. */
export const purgeTrashedSchema = z.object({ confirmPermanentDelete: z.unknown().optional() });

/** Params of /api/transfers/:id and its sub-routes. */
export const jobParamsSchema = z.object({ id: z.string().regex(JOB_ID_PATTERN, 'invalid transfer id') });

/** Parses request input with a zod schema; a failure becomes a 400 `bad_request` HttpError. */
export function parseOrBadRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  throw badRequest(`Invalid parameter (${where}${issue?.message ?? 'invalid input'}).`);
}
