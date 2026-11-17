import type { SseEvent } from '@multicloud/shared';

/**
 * Callbacks of ONE event-stream connection. The transport never reconnects by itself: after
 * `onIdle` or `onClose` the connection is over and it is up to the caller to open a new one.
 */
export interface StreamHandlers {
  onOpen: () => void;
  onEvent: (event: SseEvent) => void;
  /** The server ended the stream on purpose because no job is active ("come back later"). */
  onIdle: () => void;
  /** The stream ended for any other reason (network drop, server restart, HTTP error). */
  onClose: () => void;
}

/** Opens one connection. Returns a function that closes it (idempotent, no callbacks after it). */
export type OpenStream = (handlers: StreamHandlers) => () => void;

/**
 * - `off`: no job is active, so no stream is wanted (and none is open).
 * - `connecting`: a stream is being opened.
 * - `open`: the stream is up and delivering events.
 * - `waiting`: a job is active but the stream is down; a reconnect is scheduled (with backoff).
 */
export type LiveState = 'off' | 'connecting' | 'open' | 'waiting';

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LiveConnectionOptions {
  open: OpenStream;
  /** Every successful (re)connection: refetch the lists, events may have been missed. */
  onConnected: () => void;
  onEvent: (event: SseEvent) => void;
  /** The stream ended (`idle`: the server said nothing is running). */
  onEnded?: (reason: 'idle' | 'closed') => void;
  /** Gentle poll while a job is active and the stream is down. */
  onPoll: () => void;
  onStateChange?: (state: LiveState) => void;
  timers?: Timers;
  /** First reconnect delay, doubled after every stream that ended without delivering an event. */
  initialRetryMs?: number;
  maxRetryMs?: number;
  pollMs?: number;
}

export interface LiveConnection {
  /** Connect while true, disconnect (and stop all timers) while false. */
  setActive(active: boolean): void;
  readonly state: LiveState;
  dispose(): void;
}

export const LIVE_INITIAL_RETRY_MS = 1_000;
export const LIVE_MAX_RETRY_MS = 30_000;
export const LIVE_POLL_MS = 15_000;

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Connection policy of the live progress stream (GET /api/events):
 *
 * 1. A stream is open only while `setActive(true)`, i.e. while at least one job is queued or running.
 * 2. `setActive(false)` closes it at once and cancels every pending reconnect and poll.
 * 3. When a stream ends (server idle event, server close, network error) it is NOT reopened by the
 *    browser; it is reopened by this controller only if a job is still active, after a capped
 *    exponential backoff (1 s, 2 s, 4 s ... 30 s). The backoff resets only when a stream actually
 *    delivered an event, or when activity starts anew, so open-then-close cycles never spin.
 * 4. While active and down, `onPoll` runs every 15 s so the progress still moves.
 */
export function createLiveConnection(options: LiveConnectionOptions): LiveConnection {
  const timers = options.timers ?? defaultTimers;
  const initialRetryMs = options.initialRetryMs ?? LIVE_INITIAL_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? LIVE_MAX_RETRY_MS;
  const pollMs = options.pollMs ?? LIVE_POLL_MS;

  let active = false;
  let disposed = false;
  let state: LiveState = 'off';
  let closeStream: (() => void) | null = null;
  // Identifies the current stream so callbacks of an older one are ignored.
  let generation = 0;
  let retryHandle: unknown = null;
  let pollHandle: unknown = null;
  let failures = 0;

  const setState = (next: LiveState): void => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const stopRetry = (): void => {
    if (retryHandle !== null) timers.clearTimeout(retryHandle);
    retryHandle = null;
  };

  const stopPoll = (): void => {
    if (pollHandle !== null) timers.clearTimeout(pollHandle);
    pollHandle = null;
  };

  const startPoll = (): void => {
    if (pollHandle !== null) return;
    pollHandle = timers.setTimeout(() => {
      pollHandle = null;
      if (!active || disposed || state === 'open') return;
      options.onPoll();
      startPoll();
    }, pollMs);
  };

  const closeCurrent = (): void => {
    generation += 1;
    const close = closeStream;
    closeStream = null;
    close?.();
  };

  const scheduleReconnect = (): void => {
    const delay = Math.min(initialRetryMs * 2 ** failures, maxRetryMs);
    failures += 1;
    setState('waiting');
    stopRetry();
    retryHandle = timers.setTimeout(() => {
      retryHandle = null;
      if (active && !disposed) connect();
    }, delay);
    startPoll();
  };

  const ended = (reason: 'idle' | 'closed'): void => {
    closeCurrent();
    options.onEnded?.(reason);
    // onEnded may have deactivated us (e.g. a synchronous list refresh); check again.
    if (!active || disposed) {
      setState('off');
      return;
    }
    scheduleReconnect();
  };

  function connect(): void {
    closeCurrent();
    const mine = generation;
    const current = (): boolean => mine === generation && !disposed;
    setState('connecting');
    closeStream = options.open({
      onOpen: () => {
        if (!current()) return;
        setState('open');
        stopPoll();
        options.onConnected();
      },
      onEvent: (event) => {
        if (!current()) return;
        failures = 0;
        options.onEvent(event);
      },
      onIdle: () => {
        if (current()) ended('idle');
      },
      onClose: () => {
        if (current()) ended('closed');
      },
    });
    // `open` may have reported the end synchronously.
    if (mine !== generation) closeStream = null;
  }

  return {
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (next) {
        failures = 0;
        if (closeStream === null) {
          stopRetry();
          connect();
        }
        return;
      }
      stopRetry();
      stopPoll();
      closeCurrent();
      setState('off');
    },
    get state() {
      return state;
    },
    dispose() {
      if (disposed) return;
      active = false;
      stopRetry();
      stopPoll();
      closeCurrent();
      disposed = true;
      setState('off');
    },
  };
}
