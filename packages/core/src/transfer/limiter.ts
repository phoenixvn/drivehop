export interface Limiter {
  /** Runs `task` once a slot is free; at most `concurrency` tasks run at the same time (FIFO). */
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly pending: number;
}

export function createLimiter(concurrency: number): Limiter {
  const limit = Math.max(1, Math.floor(concurrency));
  const waiting: Array<() => void> = [];
  let active = 0;

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        // The finishing task hands its slot over directly, so `active` is not touched here.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active++;
      }
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
    get active() {
      return active;
    },
    get pending() {
      return waiting.length;
    },
  };
}
