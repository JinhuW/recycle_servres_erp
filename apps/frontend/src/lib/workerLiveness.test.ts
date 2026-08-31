import { describe, it, expect } from 'vitest';
import { liveness, STALE_AFTER_MS, DEAD_AFTER_MS } from './workerLiveness';

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
