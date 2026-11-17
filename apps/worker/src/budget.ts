// Per-run subrequest budget of the alarm loop, on top of createSubrequestBudget from core.
import { createSubrequestBudget } from '@multicloud/core';
import type { SubrequestBudget, SubrequestBudgetOptions } from '@multicloud/core';

export { createSubrequestBudget };
export type { SubrequestBudget, SubrequestBudgetOptions };

/**
 * The engine receives ONE budget object for its whole life, but the platform limit applies per
 * invocation (each alarm run). The facade delegates to the budget of the current run; outside a run
 * (requests that browse folders) it is unlimited, because those subrequests count against the
 * request's own invocation, not against the alarm's.
 */
export interface BudgetFacade extends SubrequestBudget {
  /** Starts a fresh per-run budget and returns it. */
  beginRun(options: SubrequestBudgetOptions): SubrequestBudget;
  endRun(): void;
}

export function createBudgetFacade(): BudgetFacade {
  let current: SubrequestBudget | null = null;
  return {
    beginRun(options) {
      current = createSubrequestBudget(options);
      return current;
    },
    endRun() {
      current = null;
    },
    count(n = 1) {
      current?.count(n);
    },
    remaining() {
      return current === null ? Number.POSITIVE_INFINITY : current.remaining();
    },
    canStartItem() {
      return current === null ? true : current.canStartItem();
    },
  };
}

/** Wraps `fetch` so that every outgoing subrequest is counted before it is sent. */
export function countingFetch(base: typeof fetch, budget: Pick<SubrequestBudget, 'count'>): typeof fetch {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    budget.count(1);
    return base(input, init);
  };
  return wrapped as typeof fetch;
}
