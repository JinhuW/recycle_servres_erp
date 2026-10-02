import { describe, it, expect, vi, afterEach } from 'vitest';
import { onShutdown } from '../src/lib/shutdown';

function fakes(closeAfterMs: number | null) {
  const order: string[] = [];
  let onClosed: (() => void) | undefined;
  const server = {
    close: vi.fn((cb?: (err?: Error) => void) => {
      order.push('close');
      onClosed = () => cb?.();
      if (closeAfterMs !== null) setTimeout(() => onClosed?.(), closeAfterMs);
      return server as never;
    }),
    // Cutting the sockets is what lets a stuck close() finish.
    closeAllConnections: vi.fn(() => { order.push('cut'); onClosed?.(); }),
  };
  const loops = [{ stop: vi.fn(() => order.push('loop')) }, { stop: vi.fn(() => order.push('loop')) }];
  const closeDb = vi.fn(async () => { order.push('db'); });
  const exit = vi.fn((code: number) => { order.push(`exit ${code}`); });
  return { order, server, loops, closeDb, exit };
}

describe('onShutdown', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('stops loops, drains, closes the pool, then exits 0', async () => {
    vi.useFakeTimers();
    const f = fakes(50);
    const done = onShutdown({ ...f, graceMs: 1_000, hardMs: 2_000 })('SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(f.order).toEqual(['loop', 'loop', 'close', 'db', 'exit 0']);
    expect(f.server.closeAllConnections).not.toHaveBeenCalled();
  });

  it('cuts open connections once the grace period passes', async () => {
    vi.useFakeTimers();
    const f = fakes(null);
    const done = onShutdown({ ...f, graceMs: 1_000, hardMs: 5_000 })('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(f.order).toEqual(['loop', 'loop', 'close', 'cut', 'db', 'exit 0']);
  });

  it('exits 1 at the hard deadline when draining hangs', async () => {
    vi.useFakeTimers();
    const f = fakes(null);
    f.server.closeAllConnections.mockImplementation(() => { f.order.push('cut'); });
    void onShutdown({ ...f, graceMs: 1_000, hardMs: 3_000 })('SIGTERM');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.exit).toHaveBeenCalledWith(1);
  });

  it('ignores a second signal', async () => {
    vi.useFakeTimers();
    const f = fakes(10);
    const handler = onShutdown({ ...f, graceMs: 1_000, hardMs: 2_000 });
    const first = handler('SIGTERM');
    void handler('SIGINT');
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(f.server.close).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledTimes(1);
  });
});
