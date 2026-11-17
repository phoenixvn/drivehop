// GET /api/events served by the Durable Object. Same wire format as the Node host
// (formatSse / SSE_KEEP_ALIVE_COMMENT from core), plus a quiet-period close: an open stream keeps
// the object in memory and is billed as duration, so when no job is queued or running for
// SSE_QUIET_CLOSE_MS the stream ends with a final `stream.idle` event.
import { SSE_KEEP_ALIVE_COMMENT, formatSse } from '@multicloud/core';
import type { SseEvent } from '@multicloud/shared';

/** Heartbeat comment interval while the stream is open. */
export const SSE_HEARTBEAT_MS = 15_000;
/** The stream is closed after this long without queued/running work. */
export const SSE_QUIET_CLOSE_MS = 30_000;
/**
 * `retry:` sent to the browser: how long EventSource waits before reconnecting after the server
 * ended the stream. Long enough that an idle tab does not keep the object awake.
 */
export const SSE_IDLE_RETRY_MS = 60_000;
/**
 * Name of the final event. Not one of SSE_EVENT_TYPES, so the current web client ignores it (it only
 * listens to the four job/item events); its data says when the client may reconnect.
 */
export const SSE_IDLE_EVENT = 'stream.idle';

export interface SseSource {
  subscribe(listener: (event: SseEvent) => void): () => void;
  hasWork(): boolean;
}

export interface SseStreamOptions {
  heartbeatMs?: number;
  quietCloseMs?: number;
  idleRetryMs?: number;
  /** How often the quiet period is checked. Default min(heartbeat, quiet) / 3. */
  checkEveryMs?: number;
  headers?: Record<string, string>;
}

export function createSseResponse(source: SseSource, options: SseStreamOptions = {}): Response {
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const quietCloseMs = options.quietCloseMs ?? SSE_QUIET_CLOSE_MS;
  const idleRetryMs = options.idleRetryMs ?? SSE_IDLE_RETRY_MS;
  const checkEveryMs = options.checkEveryMs ?? Math.max(50, Math.floor(Math.min(heartbeatMs, quietCloseMs) / 3));
  const encoder = new TextEncoder();

  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastBeat = Date.now();
      let quietSince: number | null = source.hasWork() ? null : Date.now();

      const stop = (): void => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        unsubscribe();
      };
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };

      unsubscribe = source.subscribe((event) => {
        quietSince = null;
        send(formatSse(event));
      });
      send(SSE_KEEP_ALIVE_COMMENT);

      timer = setInterval(() => {
        const now = Date.now();
        if (source.hasWork()) {
          quietSince = null;
        } else if (quietSince === null) {
          quietSince = now;
        } else if (now - quietSince >= quietCloseMs) {
          send(`retry: ${idleRetryMs}\nevent: ${SSE_IDLE_EVENT}\ndata: ${JSON.stringify({ reconnectAfterMs: idleRetryMs })}\n\n`);
          stop();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
          return;
        }
        if (now - lastBeat >= heartbeatMs) {
          lastBeat = now;
          send(SSE_KEEP_ALIVE_COMMENT);
        }
      }, checkEveryMs);
    },
    cancel() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      unsubscribe();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...options.headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
