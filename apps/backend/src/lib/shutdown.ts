import type { Server } from 'node:http';

import { log } from './log';

// A redeploy sends SIGTERM and, after the draining window, SIGKILL. The
// container's PID 1 gets no default action for a signal it has no handler
// for, so SIGTERM did nothing and every redeploy ended in a kill mid-request:
// a write rolled back after the client saw no answer, an upload orphaned in R2.
// This stops the timers, lets in-flight requests finish, closes the pool and
// exits on its own terms.
export type ShutdownDeps = {
  server: Pick<Server, 'close' | 'closeAllConnections'>;
  loops: ReadonlyArray<{ stop(): void }>;
  closeDb: () => Promise<void>;
  // In-flight requests get this long; then open sockets are cut. An MCP
  // session or an SSE stream never ends on its own, so `close()` alone
  // would wait for ever.
  graceMs: number;
  // Exit regardless, inside the platform's draining window.
  hardMs: number;
  exit?: (code: number) => void;
};

export function onShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let started = false;
  return async (signal: string) => {
    if (started) return;
    started = true;
    log.info('shutting down', { signal });
    const hard = setTimeout(() => {
      log.warn('shutdown deadline passed; exiting');
      exit(1);
    }, deps.hardMs);
    hard.unref?.();

    for (const loop of deps.loops) loop.stop();
    const grace = setTimeout(() => deps.server.closeAllConnections(), deps.graceMs);
    grace.unref?.();
    await new Promise<void>((resolve) => deps.server.close(() => resolve()));
    clearTimeout(grace);
    await deps.closeDb().catch((e) => log.error('closing the database pool failed', e));
    clearTimeout(hard);
    exit(0);
  };
}
