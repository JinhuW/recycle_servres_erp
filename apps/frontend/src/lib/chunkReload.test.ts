import { describe, it, expect } from 'vitest';
import { shouldReload } from './chunkReload';

// A tiny stand-in for sessionStorage. `throws` covers the contexts where the
// accessor itself raises rather than returning null — a locked-down or
// partitioned browser — which must not cost the user their one reload.
function store(initial?: string, throws = false): Pick<Storage, 'getItem' | 'setItem'> & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() { if (throws) throw new Error('denied'); return this.value; },
    setItem(_k: string, v: string) { if (throws) throw new Error('denied'); this.value = v; },
  };
}

describe('shouldReload', () => {
  it('reloads on the first chunk failure and records when', () => {
    const s = store();
    expect(shouldReload(s, 1_000_000)).toBe(true);
    expect(s.value).toBe('1000000');
  });

  it('refuses a second reload inside the guard window', () => {
    const s = store();
    shouldReload(s, 1_000_000);
    expect(shouldReload(s, 1_030_000)).toBe(false);
  });

  it('keeps the original stamp when it refuses, so the window cannot be extended', () => {
    const s = store();
    shouldReload(s, 1_000_000);
    shouldReload(s, 1_030_000);
    shouldReload(s, 1_050_000);
    // Still the first attempt: a failure storm inside the window must not push
    // the deadline out ahead of itself.
    expect(s.value).toBe('1000000');
    expect(shouldReload(s, 1_061_000)).toBe(true);
  });

  it('allows a fresh reload once the window has passed', () => {
    const s = store();
    shouldReload(s, 1_000_000);
    expect(shouldReload(s, 1_060_001)).toBe(true);
  });

  it('treats a much later deploy as a first failure', () => {
    // The guard is a timestamp rather than a flag precisely so this holds: a
    // user who hit one bad deploy still gets an attempt at the next one.
    const s = store(String(1_000_000));
    expect(shouldReload(s, 1_000_000 + 90 * 24 * 3_600_000)).toBe(true);
  });

  it('reloads rather than giving up when the stored value is garbage', () => {
    expect(shouldReload(store('not-a-number'), 1_000_000)).toBe(true);
  });

  it('reloads when storage throws', () => {
    expect(shouldReload(store(undefined, true), 1_000_000)).toBe(true);
  });
});
