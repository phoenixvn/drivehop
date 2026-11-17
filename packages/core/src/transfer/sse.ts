import type { SseEvent, TransferEngine } from '@multicloud/shared';

/** Interval of the ':keep-alive' comment, in milliseconds. */
export const SSE_KEEP_ALIVE_MS = 15_000;

export const SSE_KEEP_ALIVE_COMMENT = ':keep-alive\n\n';

/**
 * Wire format of one event:
 *
 *     event: <event.type>
 *     data: <JSON of the whole event, i.e. {"type":...,"payload":...}>
 *     <blank line>
 *
 * The `event:` field lets browsers use `addEventListener(type, ...)` (see SSE_EVENT_TYPES), and the
 * data line is a complete SseEvent, so `JSON.parse(e.data) as SseEvent` works in every listener.
 */
export function formatSse(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The subset of Node's `http.ServerResponse` the helper needs (Fastify: `reply.raw` after `reply.hijack()`). */
export interface SseResponseLike {
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
  flushHeaders?: () => unknown;
}

export interface AttachSseOptions {
  /** Default 15000. */
  keepAliveMs?: number;
  /** Extra response headers (e.g. CORS headers, which a hijacked Fastify reply does not add itself). */
  headers?: Record<string, string>;
}

/**
 * Turns `res` into a Server-Sent-Events stream of the engine's events: writes the SSE headers,
 * sends a ':keep-alive' comment immediately and then every 15 s, and stops (unsubscribes, clears
 * the timer) when the response closes. Returns a function that detaches and ends the response.
 */
export function attachSseStream(
  engine: Pick<TransferEngine, 'subscribe'>,
  res: SseResponseLike,
  options: AttachSseOptions = {},
): () => void {
  let active = true;
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;

  const cleanup = (): void => {
    if (!active) return;
    active = false;
    if (timer !== undefined) clearInterval(timer);
    unsubscribe();
  };

  const send = (chunk: string): void => {
    if (!active) return;
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  };

  res.writeHead(200, {
    ...options.headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.on('close', cleanup);

  // Subscribe and start the timer before the first write, so a failing write can clean both up.
  unsubscribe = engine.subscribe((event) => send(formatSse(event)));
  timer = setInterval(() => send(SSE_KEEP_ALIVE_COMMENT), options.keepAliveMs ?? SSE_KEEP_ALIVE_MS);
  timer.unref?.();
  send(SSE_KEEP_ALIVE_COMMENT);

  return () => {
    const wasActive = active;
    cleanup();
    if (wasActive) {
      try {
        res.end();
      } catch {
        // The socket is already gone.
      }
    }
  };
}
