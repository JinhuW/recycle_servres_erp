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
  // A failed debounced write; the queue re-reads after it either way.
  onWriteError?: (e: unknown) => void;
};

export type LoadState = 'loading' | 'ok' | 'error';

// Per-line progress saved as it is made — Review mode's write rules, as a hook.
// Each line's latest state waits out a short debounce in `pending`, then goes
// out behind any earlier write of the same line (`inflight`), so a scanner
// burst is one write and two writes of a line never land out of order.
// Nothing should write until `loadState` is 'ok': an action taken against the
// full-count default would overwrite a count on file.
export function useLineSaveQueue<R>(options: Options<R>) {
  const opts = useRef(options);
  opts.current = options;
  const [checks, setChecks] = useState<Map<string, LineCheck>>(new Map());
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const pending = useRef(new Map<string, LineCheck>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Map<string, Promise<R>>());

  // The server's copy, except where a write of ours is still on its way —
  // there the page is newer.
  const applyServer = useCallback((r: R) => {
    opts.current.onServer?.(r);
    setChecks(prev => {
      const next = new Map(opts.current.checksOf(r).map(c => [c.lineId, c]));
      for (const id of [...pending.current.keys(), ...inflight.current.keys()]) {
        const mine = prev.get(id);
        if (mine) next.set(id, mine);
      }
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    // A retry after a failed first read shows as loading again.
    setLoadState(s => (s === 'error' ? 'loading' : s));
    try {
      applyServer(await opts.current.read());
      setLoadState('ok');
    } catch (e) {
      handleFetchError(e);
      // A failed re-read leaves the page's own copy standing.
      setLoadState(s => (s === 'ok' ? 'ok' : 'error'));
    }
  }, [applyServer]);

  useEffect(() => { void reload(); }, [reload]);

  const put = useCallback((c: LineCheck): Promise<R> => {
    const before: Promise<unknown> = inflight.current.get(c.lineId) ?? Promise.resolve(null);
    const p = before.catch(() => null).then(() => opts.current.send(c));
    inflight.current.set(c.lineId, p);
    const settle = () => { if (inflight.current.get(c.lineId) === p) inflight.current.delete(c.lineId); };
    p.then(settle, settle);
    return p;
  }, []);

  const fire = useCallback((id: string): Promise<R> | null => {
    const t0 = timers.current.get(id);
    if (t0) clearTimeout(t0);
    timers.current.delete(id);
    const c = pending.current.get(id);
    pending.current.delete(id);
    return c ? put(c) : null;
  }, [put]);

  // Leaving the page sends what is still waiting rather than dropping it.
  useEffect(() => () => {
    for (const id of [...pending.current.keys()]) fire(id)?.catch(() => {});
  }, [fire]);
  useEffect(() => {
    const onHide = () => {
      for (const [id, c] of pending.current) {
        clearTimeout(timers.current.get(id));
        opts.current.beacon(c);
      }
      pending.current.clear();
      timers.current.clear();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // Optimistic: the row moves the moment it is ticked.
  const save = useCallback((next: LineCheck) => {
    setChecks(m => new Map(m).set(next.lineId, next));
    pending.current.set(next.lineId, next);
    const t0 = timers.current.get(next.lineId);
    if (t0) clearTimeout(t0);
    timers.current.set(next.lineId, setTimeout(() => {
      fire(next.lineId)?.catch((e) => {
        (opts.current.onWriteError ?? handleFetchError)(e);
        void reload();
      });
    }, SAVE_DELAY_MS));
  }, [fire, reload]);

  // Everything waiting goes out, and everything already out lands, before
  // anything acts on the server's copy. A write that failed stops the caller.
  const flush = useCallback(async () => {
    for (const id of [...pending.current.keys()]) fire(id)?.catch(() => {});
    const results = await Promise.allSettled([...inflight.current.values()]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      void reload();
      throw failed.reason;
    }
  }, [fire, reload]);

  // A server read the page fetched itself, such as a batch write's reply.
  return { checks, loadState, reload, save, flush, accept: applyServer };
}
