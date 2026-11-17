import { attachSseStream, createTransferSchema, jobParamsSchema, purgeTrashedSchema } from '@multicloud/core';
import type { TransferEngineHandle } from '@multicloud/core';
import { API_ERROR_CODES, API_PATHS, isTerminalJobStatus } from '@multicloud/shared';
import type {
  CancelTransferResponse,
  CreateTransferRequest,
  CreateTransferResponse,
  GetTransferResponse,
  ListTransfersResponse,
  PurgeTrashedResult,
  RetryFailedTransferResponse,
} from '@multicloud/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ConfigStatus } from '../config.ts';
import type { AccountsRepo } from '../db/accounts.ts';
import { HttpError, notConfigured, notFound } from '../errors.ts';
import { parseOrBadRequest, requireAccount } from './deps.ts';

export { MAX_SOURCE_FILE_IDS } from '@multicloud/core';

/** How long POST .../cancel waits for a running job to wind down before answering anyway. */
export const DEFAULT_CANCEL_GRACE_MS = 300;

export interface TransferRouteDeps {
  engine: TransferEngineHandle;
  accounts: AccountsRepo;
  getStatus: () => ConfigStatus;
  /** Origin of the web UI; the only origin that gets CORS headers on the event stream. */
  webOrigin: string;
  /** Open event streams register their detach function here so the server can end them on close. */
  eventStreams: Set<() => void>;
  cancelGraceMs?: number;
  /** Keep-alive interval of the event stream (tests). */
  sseKeepAliveMs?: number;
}

function jobNotFound(): HttpError {
  return notFound('Không tìm thấy tác vụ chuyển tệp này.');
}

/**
 * POST/GET /api/transfers, GET /api/transfers/:id, cancel, retry-failed and the SSE stream
 * GET /api/events. Engine rejections (TransferError, ProviderError, HttpError) are turned into
 * `{ code, message }` by the application's error handler.
 */
export const transferRoutes: FastifyPluginAsync<TransferRouteDeps> = async (app, deps) => {
  const { engine, accounts, eventStreams } = deps;
  const cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;

  app.post(API_PATHS.transfers, async (request, reply): Promise<CreateTransferResponse> => {
    // Checked here, not left to the engine: a cross-account job only resolves its providers once
    // it runs, so it would otherwise be accepted and then fail in the background.
    const status = deps.getStatus();
    if (!status.configured) throw notConfigured(status.missing);

    const body = parseOrBadRequest(createTransferSchema, request.body);
    if (body.mode === 'move' && body.confirmMove !== true) {
      throw new HttpError(
        400,
        API_ERROR_CODES.moveNotConfirmed,
        'Thao tác di chuyển phải được xác nhận (confirmMove: true) vì tệp gốc sẽ bị chuyển vào thùng rác.',
      );
    }
    requireAccount(accounts, body.sourceAccountId);
    requireAccount(accounts, body.destAccountId);

    const req: CreateTransferRequest = {
      mode: body.mode,
      sourceAccountId: body.sourceAccountId,
      destAccountId: body.destAccountId,
      destFolderId: body.destFolderId,
      sourceFileIds: body.sourceFileIds,
      ...(body.confirmMove === true ? { confirmMove: true } : {}),
    };
    const job = await engine.createJob(req);
    reply.status(201);
    return { job };
  });

  app.get(API_PATHS.transfers, async (): Promise<ListTransfersResponse> => ({ jobs: engine.listJobs() }));

  app.get(API_PATHS.transfer, async (request): Promise<GetTransferResponse> => {
    const { id } = parseOrBadRequest(jobParamsSchema, request.params);
    const job = engine.getJob(id);
    if (job === undefined) throw jobNotFound();
    return { job };
  });

  app.post(API_PATHS.transferCancel, async (request): Promise<CancelTransferResponse> => {
    const { id } = parseOrBadRequest(jobParamsSchema, request.params);
    const current = engine.getJob(id);
    if (current === undefined) throw jobNotFound();
    if (isTerminalJobStatus(current.status)) return { job: current };

    // engine.cancel() aborts at once but only resolves when in-flight provider calls and the
    // cleanup (removing temporary permissions) are over, which can take as long as one upload
    // chunk or a retry backoff. The response does not wait for that: after a short grace period it
    // carries the job as it is now; `job.finished` on /api/events reports the final state.
    const log = request.log;
    const canceling = engine.cancel(id).then(
      () => undefined,
      () => log.warn({ jobId: id }, 'cancel of a transfer job failed'),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, cancelGraceMs);
    });
    await Promise.race([canceling, grace]);
    if (timer !== undefined) clearTimeout(timer);

    const job = engine.getJob(id);
    if (job === undefined) throw jobNotFound();
    return { job };
  });

  app.post(API_PATHS.transferRetryFailed, async (request): Promise<RetryFailedTransferResponse> => {
    const { id } = parseOrBadRequest(jobParamsSchema, request.params);
    return { job: await engine.retryFailed(id) };
  });

  // Explicit, separately confirmed PERMANENT delete of the originals a finished move job trashed.
  app.post(API_PATHS.transferPurgeTrashed, async (request): Promise<PurgeTrashedResult> => {
    const { id } = parseOrBadRequest(jobParamsSchema, request.params);
    const body = parseOrBadRequest(purgeTrashedSchema, request.body ?? {});
    if (body.confirmPermanentDelete !== true) {
      throw new HttpError(400, API_ERROR_CODES.purgeNotConfirmed, 'Xóa vĩnh viễn phải được xác nhận rõ ràng (confirmPermanentDelete: true) vì không thể hoàn tác.');
    }
    if (engine.getJob(id) === undefined) throw jobNotFound();
    return engine.purgeTrashedSources(id, { maxItems: 500 });
  });

  // Server-Sent Events. The reply is hijacked (Fastify no longer touches it, so the CORS plugin
  // adds nothing): attachSseStream writes the headers, an immediate ':keep-alive' and every event.
  app.get(API_PATHS.events, (request, reply) => {
    const headers: Record<string, string> = { Vary: 'Origin' };
    if (request.headers.origin === deps.webOrigin) {
      headers['Access-Control-Allow-Origin'] = deps.webOrigin;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    reply.hijack();
    const detach = attachSseStream(engine, reply.raw, {
      headers,
      ...(deps.sseKeepAliveMs === undefined ? {} : { keepAliveMs: deps.sseKeepAliveMs }),
    });
    eventStreams.add(detach);
    reply.raw.on('close', () => eventStreams.delete(detach));
  });
};
