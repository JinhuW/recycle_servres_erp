import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/api', () => ({ ApiError: class extends Error {} }));
const { pollGate } = await import('./shared');

const flush = () => new Promise(r => setTimeout(r, 0));

function deferredReads() {
  const releases: (() => void)[] = [];
  const read = vi.fn(() => new Promise<void>(resolve => releases.push(resolve)));
  return { read, releases };
}

describe('pollGate', () => {
  it('drops a tick while the previous read is in flight', async () => {
    const { read, releases } = deferredReads();
    const gate = pollGate(read);
    gate.tick();
    gate.tick();
    gate.tick();
    expect(read).toHaveBeenCalledTimes(1);
    releases[0]();
    await flush();
    gate.tick();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('runs a reload asked for mid-read once that read lands', async () => {
    const { read, releases } = deferredReads();
    const gate = pollGate(read);
    gate.tick();
    gate.reload();
    gate.reload();
    expect(read).toHaveBeenCalledTimes(1);
    releases[0]();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    releases[1]();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('frees itself after a failed read', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    const gate = pollGate(read);
    gate.tick();
    await flush();
    gate.tick();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
