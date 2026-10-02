import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../src/lib/semaphore';

describe('createSemaphore', () => {
  it('never runs more than max at once and serves the queue in order', async () => {
    const run = createSemaphore(2, 1_000, () => new Error('busy'));
    let live = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3, 4].map((i) => run(async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      order.push(i);
      live--;
    })));
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('gives up with the caller-built error once the wait runs out', async () => {
    const run = createSemaphore(1, 30, () => new Error('busy'));
    const hold = run(() => new Promise((r) => setTimeout(r, 200)));
    await expect(run(async () => 'late')).rejects.toThrow('busy');
    await hold;
    await expect(run(async () => 'free')).resolves.toBe('free');
  });
});
