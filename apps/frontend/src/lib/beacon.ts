// Telemetry that survives arriving before the session does.
//
// lib/timing.ts and lib/errorToast.ts both post to authenticated endpoints, and
// both fire on a schedule of their own — 5s after `load`, or the moment a
// component throws. On a logged-out cold load that is earlier than the login,
// so the report 401s; `rawFetch` deliberately does not refresh or retry, and
// the report was simply lost.
//
// That loss was not spread evenly. It landed entirely on the cold loads — the
// slowest ones, the ones the timing stream exists to measure — and on any crash
// that happened before login, which is the crash least likely to be reproduced
// on request. Half of every client error ever reported was dropped this way.
//
// So: try, and on a 401 hold the report until a session exists. The endpoints
// stay authenticated; nothing new is writable without a cookie.

import { rawFetch } from './api';

type Init = Pick<RequestInit, 'keepalive'>;

/** Just enough of a Response to decide. Keeps the core testable without fetch. */
export type Post = (path: string, body: unknown, init?: Init) => Promise<{ status: number }>;

type Pending = { path: string; body: unknown; init?: Init };

// A tab that is never logged into must not accumulate. Five is more than the
// two reporters can produce in a load (one timing, and errorToast caps itself
// at five but dedupes by message first).
const MAX_PENDING = 5;

/**
 * The queue, with its transport injected.
 *
 * Pure but for the `post` it is handed, so the whole of it is testable in the
 * Node environment the frontend suite actually runs in — same split as
 * lib/chunkReload.ts.
 */
export function createBeacon(post: Post) {
  const pending: Pending[] = [];
  let established = false;

  // A re-send is a second chance, not a loop: a report that 401s again has
  // nowhere better to go, and re-queueing it would make every later login
  // retry it forever.
  const resend = (p: Pending): void => {
    void post(p.path, p.body, p.init).catch(() => {});
  };

  return {
    /**
     * Post a report. Fire-and-forget in every case: the caller gets nothing to
     * await and nothing that can throw, because a failure to report a failure
     * must not become a second failure.
     *
     * The body is captured here, at report time. lib/timing.ts folds in
     * `loadCallCounts()`, which keeps counting after this returns — re-reading
     * it at flush would describe a different load than the one measured.
     */
    send(path: string, body: unknown, init?: Init): void {
      void post(path, body, init)
        .then((res) => {
          if (res.status !== 401) return;
          // The session arrived while this was in flight — a password manager
          // filling and submitting inside the round trip is enough. Waiting for
          // an `established` that has already fired would strand the report for
          // the life of the tab.
          if (established) { resend({ path, body, init }); return; }
          if (pending.length < MAX_PENDING) pending.push({ path, body, init });
        })
        .catch(() => {
          // The network is already the problem.
        });
    },

    /** A session now exists: drain whatever was waiting for one. */
    flush(): void {
      established = true;
      // Splice before sending: a resend cannot re-enter the queue, but draining
      // first keeps that true even if that ever changes.
      const held = pending.splice(0, pending.length);
      for (const p of held) resend(p);
    },

    /** Test seam. */
    get size(): number { return pending.length; },
  };
}

export type Beacon = ReturnType<typeof createBeacon>;

// ── The wired one ────────────────────────────────────────────────────────────

// Bound at module init, not lazily on the first 401. A listener registered only
// once a report has failed can be registered after the event it is waiting for
// has already fired.
const beacon = createBeacon((path, body, init) => rawFetch('POST', path, body, undefined, init));

if (typeof window !== 'undefined') {
  window.addEventListener('auth:established', () => beacon.flush());
}

/** Post a telemetry report, holding it until a session exists if it 401s. */
export function sendBeacon(path: string, body: unknown, init?: Init): void {
  beacon.send(path, body, init);
}
