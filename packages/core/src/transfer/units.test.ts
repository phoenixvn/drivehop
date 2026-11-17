import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@multicloud/shared';
import type { SseEvent, TransferJob } from '@multicloud/shared';
import { CancelError, ItemFailure, errorCodeOf, formatError, redactSecrets } from './errors.ts';
import { createLimiter } from './limiter.ts';
import { DEFAULT_RETRY_POLICY, backoffDelay, withRetry } from './retry.ts';
import { SSE_KEEP_ALIVE_COMMENT, attachSseStream, formatSse } from './sse.ts';
import type { SseResponseLike } from './sse.ts';

// Compile-time check: a real Node response (Fastify's reply.raw) is accepted by the SSE helper.
export const acceptsServerResponse = (res: import('node:http').ServerResponse): SseResponseLike => res;

const job: TransferJob = {
  id: 'job-1',
  mode: 'copy',
  sourceAccountId: 'a',
  destAccountId: 'b',
  destFolderId: 'root',
  status: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  totals: { items: 1, done: 0, failed: 0, bytesTotal: 10, bytesDone: 0 },
};

const retryable = (): ProviderError => new ProviderError('slow down', { kind: 'rate_limit', retryable: true, status: 429 });

describe('withRetry', () => {
  const ctx = (sleeps: number[], random = 1) => ({
    policy: DEFAULT_RETRY_POLICY,
    random: () => random,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  it('backs off exponentially from 1 s with factor 2 and at most 5 attempts', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw retryable();
      }, ctx(sleeps)),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(attempts).toBe(5);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('applies jitter between 50% and 100% of the exponential delay', () => {
    expect(backoffDelay(1, DEFAULT_RETRY_POLICY, () => 0)).toBe(500);
    expect(backoffDelay(1, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(750);
    expect(backoffDelay(3, DEFAULT_RETRY_POLICY, () => 0.999999)).toBe(4000);
    expect(backoffDelay(30, DEFAULT_RETRY_POLICY, () => 1)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('returns the first success and passes the attempt number', async () => {
    const sleeps: number[] = [];
    const result = await withRetry(async (attempt) => {
      if (attempt < 3) throw retryable();
      return attempt;
    }, ctx(sleeps, 0));
    expect(result).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('does not retry non-retryable or foreign errors', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const forbidden = new ProviderError('no', { kind: 'forbidden', retryable: false, status: 403 });
    await expect(
      withRetry(async () => {
        attempts++;
        throw forbidden;
      }, ctx(sleeps)),
    ).rejects.toBe(forbidden);
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('boom');
      }, ctx(sleeps)),
    ).rejects.toThrow('boom');
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([]);
  });

  it('stops with CancelError once the signal is aborted', async () => {
    const ctl = new AbortController();
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          ctl.abort();
          throw retryable();
        },
        { ...ctx([]), signal: ctl.signal },
      ),
    ).rejects.toBeInstanceOf(CancelError);
    expect(attempts).toBe(1);
  });
});

describe('error codes', () => {
  it('derives a stable machine code first, then the detail', () => {
    expect(formatError(retryable())).toBe('rate_limit: slow down');
    expect(
      formatError(new ProviderError('doc', { kind: 'forbidden', retryable: false, code: 'google_native_not_streamable' })),
    ).toBe('google_native_not_streamable: doc');
    expect(formatError(new ItemFailure('file_too_large', 'too big'))).toBe('file_too_large: too big');
    expect(formatError(new Error('weird\n  thing'))).toBe('unknown: weird thing');
    expect(formatError(retryable(), 'verification_failed')).toBe('verification_failed: rate_limit: slow down');
    expect(errorCodeOf(new CancelError())).toBe('canceled');
    expect(errorCodeOf(new ProviderError('x', { kind: 'server', retryable: true, status: 502 }))).toBe('server');
    expect(errorCodeOf('nope')).toBe('unknown');
    // Provider codes the engine does not know never become the leading machine code.
    expect(
      formatError(new ProviderError('quota', { kind: 'forbidden', retryable: false, code: 'storageQuotaExceeded' })),
    ).toBe('forbidden: [storageQuotaExceeded] quota');
  });
});

describe('createLimiter', () => {
  it('never runs more than the limit at once and keeps FIFO order', async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        limiter.run(async () => {
          active++;
          max = Math.max(max, active);
          order.push(i);
          await new Promise((resolve) => setImmediate(resolve));
          active--;
        }),
      ),
    );
    expect(max).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(limiter.active).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('SSE', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  class FakeResponse extends EventEmitter {
    status: number | undefined;
    headers: Record<string, string> = {};
    chunks: string[] = [];
    ended = false;
    flushed = false;
    writeHead(status: number, headers: Record<string, string>): this {
      this.status = status;
      this.headers = headers;
      return this;
    }
    write(chunk: string): boolean {
      this.chunks.push(chunk);
      return true;
    }
    end(): void {
      this.ended = true;
    }
    flushHeaders(): void {
      this.flushed = true;
    }
  }

  function fakeEngine() {
    const listeners = new Set<(event: SseEvent) => void>();
    return {
      listeners,
      emit: (event: SseEvent) => listeners.forEach((l) => l(event)),
      subscribe: (listener: (event: SseEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }

  it('formats an event as a named SSE message carrying the whole event as JSON', () => {
    const event: SseEvent = { type: 'job.updated', payload: { job } };
    const text = formatSse(event);
    expect(text).toBe(`event: job.updated\ndata: ${JSON.stringify(event)}\n\n`);
    const data = text.split('\n')[1]?.slice('data: '.length) ?? '';
    expect(JSON.parse(data)).toEqual(event);
    expect(text.split('\n')).toHaveLength(4);
  });

  it('streams events with SSE headers, an immediate keep-alive and one every 15 s, and cleans up on close', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const engine = fakeEngine();
    const res = new FakeResponse();

    attachSseStream(engine, res, { headers: { 'Access-Control-Allow-Origin': 'http://localhost:5173' } });

    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': 'http://localhost:5173',
    });
    expect(res.flushed).toBe(true);
    expect(res.chunks).toEqual([SSE_KEEP_ALIVE_COMMENT]);
    expect(SSE_KEEP_ALIVE_COMMENT).toBe(':keep-alive\n\n');

    const event: SseEvent = { type: 'job.finished', payload: { job: { ...job, status: 'completed' } } };
    engine.emit(event);
    expect(res.chunks).toEqual([SSE_KEEP_ALIVE_COMMENT, formatSse(event)]);

    vi.advanceTimersByTime(14_999);
    expect(res.chunks).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(res.chunks).toHaveLength(3);
    vi.advanceTimersByTime(30_000);
    expect(res.chunks.filter((c) => c === SSE_KEEP_ALIVE_COMMENT)).toHaveLength(4);

    res.emit('close');
    expect(engine.listeners.size).toBe(0);
    engine.emit(event);
    vi.advanceTimersByTime(60_000);
    expect(res.chunks).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detaches on demand and when a write throws', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const engine = fakeEngine();
    const res = new FakeResponse();
    const detach = attachSseStream(engine, res, { keepAliveMs: 1000 });
    detach();
    detach();
    expect(res.ended).toBe(true);
    expect(engine.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const broken = new FakeResponse();
    broken.write = () => {
      throw new Error('EPIPE');
    };
    attachSseStream(engine, broken);
    expect(engine.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('redactSecrets', () => {
  it('removes token shapes, URL parameters and JSON credential fields', () => {
    const text = [
      'Bearer ya29.a0AbCdEf-gh',
      '1//0gAbCdEfGhIjKl',
      'GOCSPX-abcDEF_123',
      'https://x/upload?upload_id=AEnB2Ur&other=1',
      '{"refresh_token":"plain-value-without-prefix","client_secret": "no prefix either"}',
    ].join(' | ');
    const clean = redactSecrets(text);
    for (const secret of ['ya29', '1//0g', 'GOCSPX', 'AEnB2Ur', 'plain-value-without-prefix', 'no prefix either']) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain('other=1');
  });
});
