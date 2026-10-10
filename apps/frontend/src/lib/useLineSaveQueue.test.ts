import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineCheck } from './boxCheck';
import { createSaveQueue } from './useLineSaveQueue';

const check = (lineId: string, counted: number): LineCheck => ({ lineId, counted, checkedAt: null });

// `outcomes` is consumed one write at a time: true lands, false is refused.
function harness(...outcomes: boolean[]) {
  const sent: LineCheck[] = [];
  const errors: unknown[] = [];
  let refreshes = 0;
  let i = 0;
  const q = createSaveQueue<null>(() => ({
    send: (c) => {
      sent.push(c);
      const ok = outcomes[i++] ?? true;
      return ok ? Promise.resolve(null) : Promise.reject(new Error(`refused ${c.lineId}`));
    },
    onWriteError: (e) => { errors.push(e); },
    refresh: async () => { refreshes++; return true; },
  }));
  return { q, sent, errors, refreshes: () => refreshes };
}

describe('createSaveQueue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends only the latest state of a line after the debounce', async () => {
    const h = harness();
    h.q.save(check('a', 1));
    h.q.save(check('a', 2));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent).toEqual([check('a', 2)]);
  });

  it('flush sends what is waiting and resolves true once it lands', async () => {
    const h = harness();
    h.q.save(check('a', 3));
    await expect(h.q.flush()).resolves.toBe(true);
    expect(h.sent).toEqual([check('a', 3)]);
  });

  it('flush resolves false for a debounced write that failed before it was called', async () => {
    const h = harness(false);
    h.q.save(check('a', 3));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.errors).toHaveLength(1);
    const before = h.refreshes();
    await expect(h.q.flush()).resolves.toBe(false);
    expect(h.refreshes()).toBe(before + 1);
    // Reported once already; flush has nothing new to say about it.
    expect(h.errors).toHaveLength(1);
  });

  it('the re-read a false flush starts clears the failure, so the next flush goes ahead', async () => {
    const h = harness(false);
    h.q.save(check('a', 3));
    await vi.advanceTimersByTimeAsync(500);
    await expect(h.q.flush()).resolves.toBe(false);
    await expect(h.q.flush()).resolves.toBe(true);
  });

  it('a later successful write of the failed line clears it', async () => {
    const h = harness(false, true);
    h.q.save(check('a', 3));
    await vi.advanceTimersByTimeAsync(500);
    h.q.save(check('a', 4));
    await expect(h.q.flush()).resolves.toBe(true);
  });

  it('a successful write of another line does not clear a failure', async () => {
    const h = harness(false, true);
    h.q.save(check('a', 3));
    await vi.advanceTimersByTimeAsync(500);
    h.q.save(check('b', 1));
    await expect(h.q.flush()).resolves.toBe(false);
  });

  it('reports a write flush itself sent and refused through onWriteError', async () => {
    const h = harness(false);
    h.q.save(check('a', 3));
    await expect(h.q.flush()).resolves.toBe(false);
    expect(h.errors).toHaveLength(1);
  });

  it('a later write of a line supersedes an earlier refused one still in flight', async () => {
    const h = harness(false, true);
    h.q.save(check('a', 3));
    await vi.advanceTimersByTimeAsync(400);
    // The first write is out; this one queues behind it.
    h.q.save(check('a', 4));
    await expect(h.q.flush()).resolves.toBe(true);
    expect(h.sent.map(c => c.counted)).toEqual([3, 4]);
  });
});
