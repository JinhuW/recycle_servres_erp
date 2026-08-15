import { describe, it, expect } from 'vitest';
import { liveness, sortByLiveness, STALE_AFTER_MS, DEAD_AFTER_MS } from './workerLiveness';

const now = new Date('2026-08-14T12:00:00Z').getTime();
const beatAgo = (ms: number) => new Date(now - ms).toISOString();

describe('liveness', () => {
  it('is live below the stale threshold', () => {
    expect(liveness(beatAgo(0), now)).toBe('live');
    expect(liveness(beatAgo(STALE_AFTER_MS - 1), now)).toBe('live');
  });

  it('turns stale exactly at the stale threshold', () => {
    expect(liveness(beatAgo(STALE_AFTER_MS), now)).toBe('stale');
    expect(liveness(beatAgo(DEAD_AFTER_MS - 1), now)).toBe('stale');
  });

  it('turns dead exactly at the dead threshold', () => {
    expect(liveness(beatAgo(DEAD_AFTER_MS), now)).toBe('dead');
  });
});

describe('sortByLiveness', () => {
  const worker = (workerId: string, agoMs: number) => ({
    workerId,
    lastHeartbeatAt: beatAgo(agoMs),
  });

  it('sorts problem workers first: dead, then stale, then live', () => {
    const sorted = sortByLiveness(
      [worker('live-1', 5_000), worker('dead-1', DEAD_AFTER_MS + 1), worker('stale-1', STALE_AFTER_MS + 1)],
      now,
    );

    expect(sorted.map(w => w.workerId)).toEqual(['dead-1', 'stale-1', 'live-1']);
  });

  it('breaks ties by workerId ascending', () => {
    const sorted = sortByLiveness([worker('b', 1_000), worker('a', 2_000)], now);

    expect(sorted.map(w => w.workerId)).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const input = [worker('b', 1_000), worker('a', 2_000)];
    sortByLiveness(input, now);

    expect(input.map(w => w.workerId)).toEqual(['b', 'a']);
  });
});
