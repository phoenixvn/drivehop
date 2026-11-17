import { createContext, useContext } from 'react';
import type { ApiClient } from './client.ts';
import type { ApiSignals } from './signals.ts';

export interface ApiContextValue {
  api: ApiClient;
  /** True only in the dev-only `?mock=1` mode. */
  isMock: boolean;
  /** Failed API calls, reported app-wide (session expired, account needs reconnect). */
  signals: ApiSignals;
}

export const ApiContext = createContext<ApiContextValue | null>(null);

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error('ApiContext is missing');
  return value;
}

export function useApi(): ApiClient {
  return useApiContext().api;
}

export function useApiSignals(): ApiSignals {
  return useApiContext().signals;
}

export function useIsMock(): boolean {
  return useContext(ApiContext)?.isMock ?? false;
}
