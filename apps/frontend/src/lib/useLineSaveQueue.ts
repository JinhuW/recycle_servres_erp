import { useCallback, useEffect, useRef, useState } from 'react';
import type { LineCheck } from './boxCheck';
import { handleFetchError } from './errorToast';

const SAVE_DELAY_MS = 400;

type Options<R> = {
  read: () => Promise<R>;
  send: (c: LineCheck) => Promise<R>;
  // Closing the tab: an ordinary request would be cancelled with the page.
  beacon: (c: LineCheck) => void;
  checksOf: (r: R) => readonly LineCheck[];
  onServer?: (r: R) => void;
  // A refused write; the queue re-reads after it either way.
  onWriteError?: (e: unknown) => void;
};

export type LoadState = 'loading' | 'ok' | 'error';

type QueueDeps<R> = {
  send: (c: LineCheck) => Promise<R>;
  onWriteError: (e: unknown) => void;
  // Re-read the server's copy after a refused write; true once it is shown.
  refresh: () => Promise<boolean>;
};

// The write rules without React. Each line's latest state waits out a short
// debounce in `pending`, then goes out behind any earlier write of the same
// line (`inflight`), so a scanner burst is one write and two writes of a line
// never land out of order.
export function createSaveQueue<R>(deps: () => QueueDeps<R>) {
  const pending = new Map<string, LineCheck>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, Promise<R>>();
  // Lines whose latest write was refused. Kept past the write itself: a
  // debounced write that failed before flush() was called has already left
  // `inflight`, and the count it carried is still not on the server.
  // Each entry carries the write that failed, so a re-read that started before
  // a later refusal of the same line doesn't clear that one.
  const failed = new Map<string, number>();
  let seq = 0;

  const put = (c: LineCheck): Promise<R> => {
    const before: Promise<unknown> = inflight.get(c.lineId) ?? Promise.resolve(null);
    const p = before.catch(() => null).then(() => deps().send(c));
    inflight.set(c.lineId, p);
    const settle = () => { if (inflight.get(c.lineId) === p) inflight.delete(c.lineId); };
    // Writes of a line land in order, so the last to settle is its verdict.
    p.then(() => { settle(); failed.delete(c.lineId); }, () => { settle(); failed.set(c.lineId, ++seq); });
    return p;
  };

  const fire = (id: string): Promise<R> | null => {
    const t0 = timers.get(id);
    if (t0) clearTimeout(t0);
    timers.delete(id);
    const c = pending.get(id);
    pending.delete(id);
    return c ? put(c) : null;
  };

  return {
    // The page's copy is newer than a server read for these lines.
    unsettled: () => [...pending.keys(), ...inflight.keys()],
    save(next: LineCheck) {
      pending.set(next.lineId, next);
      const t0 = timers.get(next.lineId);
      if (t0) clearTimeout(t0);
      timers.set(next.lineId, setTimeout(() => {
        fire(next.lineId)?.catch((e) => {
          deps().onWriteError(e);
          void deps().refresh();
        });
      }, SAVE_DELAY_MS));
    },
    // Everything waiting goes out, and everything already out lands, before
    // anything acts on the server's copy. False while any line's last write
    // was refused, including one refused before this call, until the re-read
    // it starts has put the server's copy back on the page: the caller then
    // acts on what it shows, so one refusal doesn't block it for good.
    async flush(): Promise<boolean> {
      const errors: unknown[] = [];
      for (const id of [...pending.keys()]) fire(id)?.catch((e) => { errors.push(e); });
      await Promise.allSettled([...inflight.values()]);
      if (errors.length) deps().onWriteError(errors[0]);
      if (!failed.size) return true;
      const seen = [...failed];
      void deps().refresh().then((shown) => {
        if (!shown) return;
        for (const [id, n] of seen) if (failed.get(id) === n) failed.delete(id);
      });
      return false;
    },
    // Leaving the page sends what is still waiting rather than dropping it.
    sendPending() {
      for (const id of [...pending.keys()]) fire(id)?.catch(() => {});
    },
    // Closing the tab: an ordinary request would be cancelled with the page.
    beaconPending(beacon: (c: LineCheck) => void) {
      for (const [id, c] of pending) {
        clearTimeout(timers.get(id));
        beacon(c);
      }
      pending.clear();
      timers.clear();
    },
  };
}

// Per-line progress saved as it is made — Review mode's write rules, as a hook.
// Nothing should write until `loadState` is 'ok': an action taken against the
// full-count default would overwrite a count on file.
export function useLineSaveQueue<R>(options: Options<R>) {
  const opts = useRef(options);
  opts.current = options;
  const [checks, setChecks] = useState<Map<string, LineCheck>>(new Map());
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const reloadRef = useRef<() => Promise<boolean>>(async () => false);
  const queue = useRef<ReturnType<typeof createSaveQueue<R>> | null>(null);
  queue.current ??= createSaveQueue<R>(() => ({
    send: opts.current.send,
    onWriteError: opts.current.onWriteError ?? handleFetchError,
    refresh: () => reloadRef.current(),
  }));
  const q = queue.current;

  // The server's copy, except where a write of ours is still on its way —
  // there the page is newer.
  const applyServer = useCallback((r: R) => {
    opts.current.onServer?.(r);
    setChecks(prev => {
      const next = new Map(opts.current.checksOf(r).map(c => [c.lineId, c]));
      for (const id of q.unsettled()) {
        const mine = prev.get(id);
        if (mine) next.set(id, mine);
      }
      return next;
    });
  }, [q]);

  const reload = useCallback(async (): Promise<boolean> => {
    // A retry after a failed first read shows as loading again.
    setLoadState(s => (s === 'error' ? 'loading' : s));
    try {
      applyServer(await opts.current.read());
      setLoadState('ok');
      return true;
    } catch (e) {
      handleFetchError(e);
      // A failed re-read leaves the page's own copy standing.
      setLoadState(s => (s === 'ok' ? 'ok' : 'error'));
      return false;
    }
  }, [applyServer]);
  reloadRef.current = reload;

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => () => q.sendPending(), [q]);
  useEffect(() => {
    const onHide = () => q.beaconPending(opts.current.beacon);
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [q]);

  // Optimistic: the row moves the moment it is ticked.
  const save = useCallback((next: LineCheck) => {
    setChecks(m => new Map(m).set(next.lineId, next));
    q.save(next);
  }, [q]);

  const flush = useCallback(() => q.flush(), [q]);

  // A server read the page fetched itself, such as a batch write's reply.
  return { checks, loadState, reload, save, flush, accept: applyServer };
}
