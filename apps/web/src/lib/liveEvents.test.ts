import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseEvent, TransferJob } from '@multicloud/shared';
import { createLiveConnection } from './liveEvents.ts';
import type { LiveConnectionOptions, StreamHandlers } from './liveEvents.ts';

interface FakeStream {
  handlers: StreamHandlers;
  closed: boolean;
}

function job(status: TransferJob['status']): TransferJob {
  return {
    id: 'job-1',
    mode: 'copy',
    sourceAccountId: 'a',
    destAccountId: 'b',
    destFolderId: 'root',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    totals: { items: 1, done: 0, failed: 0, bytesTotal: 0, bytesDone: 0 },
  };
}

const updated: SseEvent = { type: 'job.updated', payload: { job: job('running') } };

function setup(overrides: Partial<LiveConnectionOptions> = {}) {
  const streams: FakeStream[] = [];
  const onConnected = vi.fn();
  const onEvent = vi.fn();
  const onPoll = vi.fn();
  const onEnded = vi.fn();
  const states: string[] = [];
  const connection = createLiveConnection({
    open: (handlers) => {
      const stream: FakeStream = { handlers, closed: false };
      streams.push(stream);
      return () => {
        stream.closed = true;
      };
    },
    onConnected,
    onEvent,
    onPoll,
    onEnded,
    onStateChange: (state) => states.push(state),
    ...overrides,
  });
  const last = (): FakeStream => {
    const stream = streams.at(-1);
    if (!stream) throw new Error('no stream opened');
    return stream;
  };
  return { connection, streams, last, onConnected, onEvent, onPoll, onEnded, states };
}

describe('createLiveConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens no stream while no job is active', () => {
    const t = setup();
    vi.advanceTimersByTime(120_000);
    expect(t.streams).toHaveLength(0);
    expect(t.connection.state).toBe('off');
    expect(t.onPoll).not.toHaveBeenCalled();
  });

  it('connects when a job becomes active and refetches on open', () => {
    const t = setup();
    t.connection.setActive(true);
    expect(t.streams).toHaveLength(1);
    expect(t.connection.state).toBe('connecting');
    t.last().handlers.onOpen();
    expect(t.connection.state).toBe('open');
    expect(t.onConnected).toHaveBeenCalledTimes(1);
    t.last().handlers.onEvent(updated);
    expect(t.onEvent).toHaveBeenCalledWith(updated);
  });

  it('closes the stream as soon as no job is active and stays closed', () => {
    const t = setup();
    t.connection.setActive(true);
    t.last().handlers.onOpen();
    t.connection.setActive(false);
    expect(t.last().closed).toBe(true);
    expect(t.connection.state).toBe('off');
    vi.advanceTimersByTime(300_000);
    expect(t.streams).toHaveLength(1);
    expect(t.onPoll).not.toHaveBeenCalled();
  });

  it('does not reconnect after the server idle event when nothing is active', () => {
    const t = setup({
      // The consumer refetches the list on idle and finds no active job.
      onEnded: (reason) => {
        if (reason === 'idle') t.connection.setActive(false);
      },
    });
    t.connection.setActive(true);
    t.last().handlers.onOpen();
    t.last().handlers.onIdle();
    expect(t.last().closed).toBe(true);
    expect(t.connection.state).toBe('off');
    vi.advanceTimersByTime(600_000);
    expect(t.streams).toHaveLength(1);
  });

  it('reports the idle end so the consumer can check the list', () => {
    const t = setup();
    t.connection.setActive(true);
    t.last().handlers.onOpen();
    t.last().handlers.onIdle();
    expect(t.onEnded).toHaveBeenCalledWith('idle');
  });

  it('reconnects with capped exponential backoff, never in a tight loop', () => {
    const t = setup();
    t.connection.setActive(true);
    const openTimes: number[] = [];
    let elapsed = 0;
    // The server accepts and immediately drops every connection, 40 times.
    for (let i = 0; i < 40; i += 1) {
      openTimes.push(elapsed);
      const opened = t.streams.length;
      t.last().handlers.onOpen();
      t.last().handlers.onClose();
      expect(t.connection.state).toBe('waiting');
      // Nothing happens synchronously.
      expect(t.streams).toHaveLength(opened);
      while (t.streams.length === opened) {
        vi.advanceTimersByTime(100);
        elapsed += 100;
      }
    }
    const gaps = openTimes.slice(1).map((time, i) => time - (openTimes[i] ?? 0));
    expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(Math.max(...gaps)).toBe(30000);
    expect(Math.min(...gaps)).toBe(1000);
  });

  it('resets the backoff after a stream delivered an event', () => {
    const t = setup();
    t.connection.setActive(true);
    for (let i = 0; i < 4; i += 1) {
      t.last().handlers.onClose();
      vi.runOnlyPendingTimers();
    }
    const before = t.streams.length;
    t.last().handlers.onOpen();
    t.last().handlers.onEvent(updated);
    t.last().handlers.onClose();
    vi.advanceTimersByTime(999);
    expect(t.streams).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(t.streams).toHaveLength(before + 1);
  });

  it('polls every 15 s only while active and down', () => {
    const t = setup({ initialRetryMs: 60_000, maxRetryMs: 60_000 });
    t.connection.setActive(true);
    t.last().handlers.onClose();
    vi.advanceTimersByTime(45_000);
    expect(t.onPoll).toHaveBeenCalledTimes(3);
    // Reconnect at 60 s; once open the poll stops.
    vi.advanceTimersByTime(15_000);
    t.last().handlers.onOpen();
    const polls = t.onPoll.mock.calls.length;
    vi.advanceTimersByTime(120_000);
    expect(t.onPoll).toHaveBeenCalledTimes(polls);
    // Going idle stops everything.
    t.last().handlers.onClose();
    t.connection.setActive(false);
    vi.advanceTimersByTime(120_000);
    expect(t.onPoll).toHaveBeenCalledTimes(polls);
  });

  it('cancels a pending reconnect when the job ends while the stream is down', () => {
    const t = setup();
    t.connection.setActive(true);
    t.last().handlers.onClose();
    t.connection.setActive(false);
    vi.advanceTimersByTime(600_000);
    expect(t.streams).toHaveLength(1);
  });

  it('resumes at once when a new job starts after being idle', () => {
    const t = setup();
    t.connection.setActive(true);
    t.last().handlers.onOpen();
    t.last().handlers.onIdle();
    t.connection.setActive(false);
    vi.advanceTimersByTime(60_000);
    t.connection.setActive(true);
    expect(t.streams).toHaveLength(2);
    expect(t.last().closed).toBe(false);
    t.last().handlers.onOpen();
    expect(t.onConnected).toHaveBeenCalledTimes(2);
  });

  it('a new job while waiting for a backoff reconnects immediately with a fresh backoff', () => {
    const t = setup();
    t.connection.setActive(true);
    for (let i = 0; i < 5; i += 1) {
      t.last().handlers.onClose();
      vi.runOnlyPendingTimers();
    }
    t.last().handlers.onClose();
    t.connection.setActive(false);
    const before = t.streams.length;
    t.connection.setActive(true);
    expect(t.streams).toHaveLength(before + 1);
    t.last().handlers.onClose();
    vi.advanceTimersByTime(1000);
    expect(t.streams).toHaveLength(before + 2);
  });

  it('ignores callbacks of a stream that was replaced or closed', () => {
    const t = setup();
    t.connection.setActive(true);
    const first = t.last();
    t.connection.setActive(false);
    first.handlers.onOpen();
    first.handlers.onEvent(updated);
    first.handlers.onClose();
    expect(t.onConnected).not.toHaveBeenCalled();
    expect(t.onEvent).not.toHaveBeenCalled();
    expect(t.connection.state).toBe('off');
    vi.advanceTimersByTime(60_000);
    expect(t.streams).toHaveLength(1);
  });

  it('dispose closes everything', () => {
    const t = setup();
    t.connection.setActive(true);
    t.last().handlers.onClose();
    t.connection.dispose();
    vi.advanceTimersByTime(600_000);
    expect(t.streams).toHaveLength(1);
    expect(t.onPoll).not.toHaveBeenCalled();
    t.connection.setActive(true);
    expect(t.streams).toHaveLength(1);
  });
});
