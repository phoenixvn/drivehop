import type { ApiClient } from './client.ts';
import { ApiRequestError } from './client.ts';

/** Listener for failed API calls, e.g. to refresh account cards after `needs_reconnect`. */
export type ApiErrorListener = (error: ApiRequestError) => void;

export interface ApiSignals {
  /** Called for every failed API call answered with a known error. Returns the unsubscribe function. */
  subscribe(listener: ApiErrorListener): () => void;
}

/**
 * Wraps every promise-returning method of `api` so failures are also reported to the listeners.
 * The returned client behaves exactly like `api` (same results, same rejections).
 */
export function withApiSignals(api: ApiClient): { api: ApiClient; signals: ApiSignals } {
  const listeners = new Set<ApiErrorListener>();
  const emit = (error: unknown): void => {
    if (!(error instanceof ApiRequestError)) return;
    for (const listener of listeners) listener(error);
  };
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api)) {
    if (typeof value !== 'function') {
      wrapped[key] = value;
      continue;
    }
    const method = value as (...args: unknown[]) => unknown;
    wrapped[key] = (...args: unknown[]): unknown => {
      const result = method.apply(api, args);
      // A separate, handled branch: the caller still receives the original rejection.
      if (result instanceof Promise) result.catch(emit);
      return result;
    };
  }
  return {
    api: wrapped as unknown as ApiClient,
    signals: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}
