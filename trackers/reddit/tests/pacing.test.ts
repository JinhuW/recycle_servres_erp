import {describe, expect, it} from 'vitest';
import {RedditPacer} from '../src/pacing.ts';

/** Pacer wired to a clock the test controls, so no test actually sleeps. */
function pacerAt(maxRpm: number, random = () => 0.5) {
  let clock = 1_000_000;
  const pacer = new RedditPacer({
    maxRpm,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random,
  });
  return {
    pacer,
    advance: (ms: number) => {
      clock += ms;
    },
    at: () => clock,
  };
}

describe('request spacing', () => {
  it('lets the first request through immediately', async () => {
    const {pacer, at} = pacerAt(1);
    const start = at();

    await pacer.acquire();

    expect(at()).toBe(start);
  });

  it('holds the next request until the configured gap has passed', async () => {
    const {pacer, at} = pacerAt(1);
    await pacer.acquire();
    const afterFirst = at();

    await pacer.acquire();

    expect(at() - afterFirst).toBe(60_000);
  });

  it('does not delay a request that is already late', async () => {
    const {pacer, advance, at} = pacerAt(1);
    await pacer.acquire();
    advance(120_000);
    const before = at();

    await pacer.acquire();

    expect(at()).toBe(before);
  });

  it('scales the gap with the configured rate', async () => {
    const {pacer, at} = pacerAt(6);
    await pacer.acquire();
    const afterFirst = at();

    await pacer.acquire();

    expect(at() - afterFirst).toBe(10_000);
  });
});

describe('block backoff', () => {
  it('pauses roughly a minute after the first block', async () => {
    const {pacer} = pacerAt(1);

    pacer.recordBlocked();

    expect(pacer.waitMs()).toBe(60_000);
  });

  it('doubles the pause on each consecutive block', async () => {
    const {pacer} = pacerAt(1);

    pacer.recordBlocked();
    const first = pacer.waitMs();
    pacer.recordBlocked();
    const second = pacer.waitMs();
    pacer.recordBlocked();
    const third = pacer.waitMs();

    expect(second).toBe(first * 2);
    expect(third).toBe(first * 4);
  });

  it('caps the pause at fifteen minutes plus jitter', () => {
    const {pacer} = pacerAt(1);

    for (let i = 0; i < 20; i++) pacer.recordBlocked();

    expect(pacer.waitMs()).toBeLessThanOrEqual(15 * 60_000 * 1.2);
  });

  it('spreads retries so a whole fleet does not retry in lockstep', () => {
    const low = pacerAt(1, () => 0);
    const high = pacerAt(1, () => 0.999);

    low.pacer.recordBlocked();
    high.pacer.recordBlocked();

    expect(low.pacer.waitMs()).toBeLessThan(high.pacer.waitMs());
    expect(low.pacer.waitMs()).toBeGreaterThanOrEqual(60_000 * 0.8);
    expect(high.pacer.waitMs()).toBeLessThanOrEqual(60_000 * 1.2);
  });

  it('honours a retry-after longer than our own backoff', () => {
    const {pacer} = pacerAt(1);

    pacer.recordBlocked(300);

    expect(pacer.waitMs()).toBeGreaterThan(200_000);
  });

  it('clears the pause once a request succeeds', () => {
    const {pacer} = pacerAt(1);
    pacer.recordBlocked();
    pacer.recordBlocked();

    pacer.recordSuccess();

    expect(pacer.waitMs()).toBe(0);
    pacer.recordBlocked();
    expect(pacer.waitMs()).toBe(60_000);
  });
});

describe('server-reported rate limits', () => {
  it('waits out the reset window when Reddit says the bucket is empty', () => {
    const {pacer} = pacerAt(1);

    pacer.recordRateLimit({remaining: 0, resetSeconds: 40});

    expect(pacer.waitMs()).toBe(40_000);
  });

  it('ignores a hint that still has budget left', () => {
    const {pacer} = pacerAt(1);

    pacer.recordRateLimit({remaining: 5, resetSeconds: 40});

    expect(pacer.waitMs()).toBe(0);
  });

  it('ignores a hint with no accounting in it', () => {
    const {pacer} = pacerAt(1);

    pacer.recordRateLimit({});

    expect(pacer.waitMs()).toBe(0);
  });

  it('never shortens a longer block already in effect', () => {
    const {pacer} = pacerAt(1);
    pacer.recordBlocked(600);
    const blocked = pacer.waitMs();

    pacer.recordRateLimit({remaining: 0, resetSeconds: 40});

    expect(pacer.waitMs()).toBe(blocked);
  });
});
