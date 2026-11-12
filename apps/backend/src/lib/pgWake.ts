import { EventEmitter } from 'node:events';
import type postgres from 'postgres';
import { log } from './log';

// ─── Long-poll wake-ups over LISTEN/NOTIFY ────────────────────────────────────
// A held request (the fleet's next-task, the chat hub's outbox claim) sleeps
// until a NOTIFY on its channel says there may be work, instead of re-querying
// on a timer. One LISTEN per pool and channel, on the dedicated connection
// postgres.js keeps for it, fanned out in-process to every armed hold. A
// NOTIFY reaches every backend instance, so work queued on one wakes a request
// held on another.
//
// Each hold arms before its first look, so work committed between that look
// and the wait still wakes it. Whoever makes work ready notifies through the
// handle that wrote it (`SELECT pg_notify(...)`), not `sql.notify`: postgres.js
// binds notify to the pool, so inside a transaction it would fire on another
// connection before the write commits and wake a hold that then finds nothing.

const plog = log.child({ module: 'pgWake' });

type Listener = { emitter: EventEmitter; ready: Promise<unknown> };
const listeners = new WeakMap<postgres.Sql, Map<string, Listener>>();

// A redeploy's drain waits on every open request, and a held one can outlast
// it: the grace then cuts the socket (a 502 at the client) and the hold wakes
// to a closed pool. So a drain ends every hold and lets no new one sleep.
let draining = false;
const armed = new Set<() => void>();

/** On at SIGTERM; the clients come back to the new instance. */
export function setHoldsDraining(on: boolean): void {
  draining = on;
  if (on) for (const wake of armed) wake();
}

export function holdsDraining(): boolean {
  return draining;
}

function listener(sql: postgres.Sql, channel: string): Listener {
  let byChannel = listeners.get(sql);
  if (!byChannel) listeners.set(sql, (byChannel = new Map()));
  let l = byChannel.get(channel);
  if (!l) {
    const emitter = new EventEmitter();
    // Armed holds: at most one per open request.
    emitter.setMaxListeners(0);
    const ready = sql.listen(channel, (payload) => emitter.emit('notify', payload))
      .catch((e: unknown) => {
        // Forget it so the next hold listens again, rather than every hold
        // sleeping out its time for the life of the process.
        byChannel.delete(channel);
        plog.warn('listener failed', { channel, error: e });
      });
    l = { emitter, ready };
    byChannel.set(channel, l);
  }
  return l;
}

/**
 * Settles once the channel's LISTEN is in place (or has failed). A hold awaits
 * it before its first look: a NOTIFY sent before LISTEN is not delivered.
 */
export function listening(sql: postgres.Sql, channel: string): Promise<unknown> {
  return listener(sql, channel).ready;
}

export type Wake = {
  /** Resolves on a NOTIFY since arming, a drain, or after `ms`. */
  wait: (ms: number) => Promise<void>;
  dispose: () => void;
};

/** Starts listening now; `wait` resolves at once if a NOTIFY already came. */
export function armWake(sql: postgres.Sql, channel: string): Wake {
  const { emitter } = listener(sql, channel);
  let fired = false;
  let release: (() => void) | null = null;
  const onNotify = () => { fired = true; release?.(); };
  emitter.on('notify', onNotify);
  armed.add(onNotify);
  return {
    wait: (ms) => new Promise<void>((resolve) => {
      if (fired || draining) return resolve();
      const timer = setTimeout(() => { release = null; resolve(); }, ms);
      release = () => { clearTimeout(timer); release = null; resolve(); };
    }),
    dispose: () => { emitter.off('notify', onNotify); armed.delete(onNotify); },
  };
}
