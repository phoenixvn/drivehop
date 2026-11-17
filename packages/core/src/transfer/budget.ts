/**
 * Work-budget hook of hosts with a per-invocation limit (subrequests, wall time). The engine asks
 * before STARTING a new item (and before listing the next page of a folder); once it answers false
 * the engine starts nothing new, lets in-flight items finish, puts the job back in the queue, and
 * `hasWork()` stays true so the host can schedule its next run.
 */
export interface WorkBudget {
  canStartItem(): boolean;
}

export interface SubrequestBudgetOptions {
  /** Subrequests this invocation may make in total. */
  limit: number;
  /** Subrequests that must still be left to start a new item. Default 25. */
  safetyMargin?: number;
}

export interface SubrequestBudget extends WorkBudget {
  /** Records `n` (default 1) subrequests made. The host calls it from its wrapped `fetch`. */
  count(n?: number): void;
  /** Subrequests left, never below 0. */
  remaining(): number;
  /** `remaining() >= safetyMargin`. */
  canStartItem(): boolean;
}

export const DEFAULT_SUBREQUEST_SAFETY_MARGIN = 25;

/**
 * Counts subrequests against a fixed per-invocation limit. One budget covers one invocation:
 * create a new one per run (the engine option can be an object that forwards to the current one).
 */
export function createSubrequestBudget(options: SubrequestBudgetOptions): SubrequestBudget {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0;
  const margin = options.safetyMargin ?? DEFAULT_SUBREQUEST_SAFETY_MARGIN;
  const safetyMargin = Number.isFinite(margin) ? Math.max(0, margin) : DEFAULT_SUBREQUEST_SAFETY_MARGIN;
  let used = 0;
  const remaining = (): number => Math.max(0, limit - used);
  return {
    count(n = 1) {
      if (Number.isFinite(n) && n > 0) used += n;
    },
    remaining,
    canStartItem() {
      return remaining() >= safetyMargin;
    },
  };
}
