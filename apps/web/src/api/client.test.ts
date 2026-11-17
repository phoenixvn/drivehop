import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferJob } from '@multicloud/shared';
import { canRetryJob, apiErrorText } from '../lib/format.ts';
import { ApiRequestError, CLIENT_ERROR_CODES, createHttpApiClient, openHttpEventStream } from './client.ts';
import { withApiSignals } from './signals.ts';

type Listener = (message: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data });
  }
}

function job(overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id: 'job-1',
    mode: 'copy',
    sourceAccountId: 'a',
    destAccountId: 'b',
    destFolderId: 'root',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    totals: { items: 3, done: 1, failed: 0, bytesTotal: 0, bytesDone: 0 },
    ...overrides,
  };
}

describe('openHttpEventStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const handlers = () => ({
    onOpen: vi.fn(),
    onEvent: vi.fn(),
    onIdle: vi.fn(),
    onClose: vi.fn(),
  });

  it('uses the relative events URL and forwards parsed events', () => {
    const h = handlers();
    openHttpEventStream(h);
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe('/api/events');
    source?.onopen?.();
    const event = { type: 'job.updated', payload: { job: job() } };
    source?.emit('job.updated', JSON.stringify(event));
    source?.emit('job.updated', 'not json');
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    expect(h.onEvent).toHaveBeenCalledWith(event);
  });

  it('closes the EventSource itself when the server ends the stream (no browser auto-reconnect)', () => {
    const h = handlers();
    openHttpEventStream(h);
    const source = FakeEventSource.instances[0];
    // A clean server close leaves readyState CONNECTING: the browser would retry on its own.
    source?.onerror?.();
    expect(source?.closeCalls).toBe(1);
    expect(source?.readyState).toBe(FakeEventSource.CLOSED);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    source?.onerror?.();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('treats the idle final event as an intentional end', () => {
    for (const name of ['stream.idle', 'idle']) {
      FakeEventSource.instances = [];
      const h = handlers();
      openHttpEventStream(h);
      const source = FakeEventSource.instances[0];
      source?.emit(name, '{}');
      source?.onerror?.();
      expect(h.onIdle).toHaveBeenCalledTimes(1);
      expect(h.onClose).not.toHaveBeenCalled();
      expect(source?.closeCalls).toBe(1);
    }
  });

  it('the returned function closes without further callbacks', () => {
    const h = handlers();
    const close = openHttpEventStream(h);
    const source = FakeEventSource.instances[0];
    close();
    source?.onopen?.();
    source?.onerror?.();
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(source?.closeCalls).toBe(1);
  });
});

describe('HTTP requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  interface FakeResponse {
    status?: number;
    ok?: boolean;
    type?: string;
    body?: string;
  }
  const stubFetch = (response: FakeResponse) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: response.ok ?? (response.status ?? 200) < 300,
      status: response.status ?? 200,
      type: response.type ?? 'basic',
      text: async () => response.body ?? '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('sends same-origin credentials, relative URLs and refuses redirects', async () => {
    const fetchMock = stubFetch({ body: '{"configured":true,"missing":[],"keyringAvailable":true}' });
    await createHttpApiClient().getStatus();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/status',
      expect.objectContaining({ credentials: 'same-origin', redirect: 'manual' }),
    );
  });

  it('maps a login redirect to session_expired', async () => {
    stubFetch({ type: 'opaqueredirect', status: 0, ok: false });
    await expect(createHttpApiClient().getStatus()).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.sessionExpired,
    });
  });

  it('maps 401/403 from the auth layer to session_expired', async () => {
    stubFetch({ status: 403, ok: false, body: '<html>Forbidden</html>' });
    await expect(createHttpApiClient().listAccounts()).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.sessionExpired,
      status: 403,
    });
    stubFetch({ status: 401, ok: false, body: '{"code":"unauthorized","message":"no"}' });
    const error = await createHttpApiClient().listAccounts().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: CLIENT_ERROR_CODES.sessionExpired });
    expect(apiErrorText(error)).toContain('tải lại trang');
  });

  it('keeps the API own 401 needs_reconnect and 403 provider_error', async () => {
    stubFetch({ status: 401, ok: false, body: '{"code":"needs_reconnect","message":"x"}' });
    await expect(createHttpApiClient().getQuota('a')).rejects.toMatchObject({
      code: 'needs_reconnect',
    });
    stubFetch({ status: 403, ok: false, body: '{"code":"provider_error","message":"x"}' });
    await expect(createHttpApiClient().getQuota('a')).rejects.toMatchObject({
      code: 'provider_error',
    });
  });
});

describe('withApiSignals', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports failed calls and still rejects to the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        type: 'basic',
        text: async () => '{"code":"needs_reconnect","message":"x"}',
      })),
    );
    const { api, signals } = withApiSignals(createHttpApiClient());
    const seen: string[] = [];
    const unsubscribe = signals.subscribe((error) => seen.push(error.code));
    await expect(api.listFiles('a')).rejects.toBeInstanceOf(ApiRequestError);
    expect(seen).toEqual(['needs_reconnect']);
    unsubscribe();
    await expect(api.listFiles('a')).rejects.toBeInstanceOf(ApiRequestError);
    expect(seen).toEqual(['needs_reconnect']);
    expect(api.authStartUrl()).toBe('/api/auth/google/start');
  });
});

describe('canRetryJob', () => {
  const totals = (done: number, failed: number, items = 3) => ({
    items,
    done,
    failed,
    bytesTotal: 0,
    bytesDone: 0,
  });

  it('offers retry for finished jobs with failed or canceled items', () => {
    expect(canRetryJob(job({ status: 'completed_with_errors', totals: totals(2, 1) }))).toBe(true);
    expect(canRetryJob(job({ status: 'canceled', totals: totals(1, 0) }))).toBe(true);
    expect(canRetryJob(job({ status: 'failed', totals: totals(0, 0) }))).toBe(true);
  });

  it('does not offer retry for running, completed or fully done jobs', () => {
    expect(canRetryJob(job({ status: 'running', totals: totals(1, 1) }))).toBe(false);
    expect(canRetryJob(job({ status: 'queued', totals: totals(0, 0) }))).toBe(false);
    expect(canRetryJob(job({ status: 'completed', totals: totals(3, 0) }))).toBe(false);
    expect(canRetryJob(job({ status: 'canceled', totals: totals(3, 0) }))).toBe(false);
    expect(canRetryJob(job({ status: 'failed', totals: totals(0, 0, 0) }))).toBe(false);
  });
});
