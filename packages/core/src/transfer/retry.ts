import { CancelError, isCancelError, isRetryable } from './errors.ts';

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryPolicy {
  /** Delay before the 2nd attempt. Default 1000. */
  baseDelayMs: number;
  /** Multiplier applied per further attempt. Default 2. */
  factor: number;
  /** Total attempts including the first. Default 5. */
  maxAttempts: number;
  /** Upper bound of a single delay. Default 60000. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1000,
  factor: 2,
  maxAttempts: 5,
  maxDelayMs: 60_000,
};

export interface RetryContext {
  policy: RetryPolicy;
  sleep: SleepFn;
  /** Returns a number in [0, 1). */
  random: () => number;
  /** When set and aborted, the loop stops with CancelError. Omit for cleanup work that must finish. */
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** Resolves after `ms`, or early (without rejecting) when the signal aborts. */
export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** "Equal jitter": between 50% and 100% of the exponential delay. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** (attempt - 1));
  return Math.round(exponential * (0.5 + 0.5 * random()));
}

/**
 * Runs `fn`, retrying only errors whose `retryable` flag is true (ProviderError), with exponential
 * backoff and jitter. Non-retryable errors and the last failed attempt are rethrown unchanged.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, ctx: RetryContext): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (ctx.signal?.aborted) throw new CancelError();
    try {
      return await fn(attempt);
    } catch (error) {
      if (isCancelError(error)) throw error;
      if (ctx.signal?.aborted) throw new CancelError();
      if (!isRetryable(error) || attempt >= ctx.policy.maxAttempts) throw error;
      const delayMs = backoffDelay(attempt, ctx.policy, ctx.random);
      ctx.onRetry?.({ attempt, delayMs, error });
      try {
        await ctx.sleep(delayMs, ctx.signal);
      } catch (sleepError) {
        if (ctx.signal?.aborted) throw new CancelError();
        throw sleepError;
      }
    }
  }
}
