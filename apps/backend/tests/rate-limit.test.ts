import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRateLimiter } from '../src/lib/rate-limit';

describe('createRateLimiter', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('allows max hits per window, then reports the wait', () => {
    vi.useFakeTimers();
    const limit = createRateLimiter(60_000, 2);
    expect(limit('a')).toBeNull();
    expect(limit('a')).toBeNull();
    expect(limit('a')).toBeGreaterThan(0);
    vi.advanceTimersByTime(60_001);
    expect(limit('a')).toBeNull();
  });

  // One entry per caller-chosen key would otherwise live for the whole process.
  it('never holds more than its key cap', () => {
    const limit = createRateLimiter(60_000, 5, 100);
    for (let i = 0; i < 1000; i++) limit(`ip-${i}`);
    // The newest keys are the ones kept, and each still counts its own hits.
    for (let i = 0; i < 4; i++) limit('ip-999');
    expect(limit('ip-999')).toBeGreaterThan(0);
  });

  // Evicting oldest-first let a flood of fresh keys push out the key being
  // throttled, which then started over with a full budget.
  it('keeps a throttled key through a flood of fresh ones', () => {
    const limit = createRateLimiter(60_000, 3, 100);
    for (let i = 0; i < 3; i++) limit('victim');
    expect(limit('victim')).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) limit(`flood-${i}`);
    expect(limit('victim')).toBeGreaterThan(0);
  });
});
