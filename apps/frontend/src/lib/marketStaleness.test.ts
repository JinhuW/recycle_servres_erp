import { describe, it, expect } from 'vitest';
import { staleness, STALE_DAYS } from './marketStaleness';

describe('staleness', () => {
  const now = new Date('2026-05-23T12:00:00Z').getTime();

  it('returns isStale=true for null lastPriceAt', () => {
    expect(staleness(null, now)).toEqual({ days: null, isStale: true });
  });

  it('returns isStale=false at exactly STALE_DAYS', () => {
    const ts = new Date(now - STALE_DAYS * 86400000).toISOString();
    const s = staleness(ts, now);
    expect(s.days).toBe(STALE_DAYS);
    expect(s.isStale).toBe(false);
  });

  it('returns isStale=true at STALE_DAYS + 1', () => {
    const ts = new Date(now - (STALE_DAYS + 1) * 86400000).toISOString();
    const s = staleness(ts, now);
    expect(s.days).toBe(STALE_DAYS + 1);
    expect(s.isStale).toBe(true);
  });

  it('returns isStale=false for a fresh today timestamp', () => {
    const ts = new Date(now - 60_000).toISOString();
    const s = staleness(ts, now);
    expect(s.days).toBe(0);
    expect(s.isStale).toBe(false);
  });
});
