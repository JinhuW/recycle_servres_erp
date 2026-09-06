---
id: RS-027
title: Telemetry is dropped exactly when the app is worst
type: bug
status: in-review
priority: P2
created: 2026-09-05
reporter: Jinhu
branch: session/20260905-204221
pr: 278
version: 1.128.1
related: [RS-019, RS-021]
---

## Ask

> Check all error log for new deploymemnt and create an fix for them.
> i meant checking the railway prod account error logs.

## Context

The triage found production healthy. Across `2026-09-01T02:13Z →
2026-09-06T00:42Z` — 6,835 lines, v1.114.1 through v1.128.0, all four prod
services — there were **zero** unhandled 500s and zero 5xx of any kind. The only
`501`s are the designed "not configured" contract on `/api/coordinator/*`
(`routes/coordinator.ts:50`). The single client-error report in the window is
the stale-chunk failure of 09-03 on v1.119.1, already fixed by `chunkReload.ts`
in v1.121.1. Every 4xx is a scanner probe, the designed token-expiry cycle, or
the deliberate `demo-accounts` 404 that hides the demo picker in prod.

What the log did show is a hole in the log itself.

**Client telemetry is discarded whenever the session is not yet established.**
`timing.ts` and `errorToast.ts` both post through `rawFetch`, which by design
does no refresh and no retry (`api.ts:207-229`). Both routes sit behind
`authMiddleware` — correctly, since an unauthenticated write into the operator's
log is a spam target (`clientTimings.ts:15-16`). So the report 401s and is
dropped on the floor.

In the window `/api/client-timings` lost 7 of 91 reports and `/api/client-errors`
lost 1 of 2. The loss is not random — it is biased to the worst loads. All seven
timing losses are real logged-out cold loads of the main shell (`/api/me` 401 →
`refresh` 401 → `demo-accounts` 404 → beacon 401), and five are followed by a
successful login within 2-10 seconds. None are vendor-portal loads; the whole
window contains one `/api/public/*` request.

Two consequences. The cold-load percentiles [RS-019](./RS-019-the-cold-load-waits-on-a-token-refresh-and-a-serial.md)
and [RS-021](./RS-021-production-cannot-explain-its-own-failures.md) exist to
produce are drawn from a sample with the slowest loads systematically removed.
And **a crash before login is never recorded at all** — half of every
client-error report ever sent was lost this way. Had the 09-03 stale-chunk
failure hit one step earlier, on the entry chunk before `/api/me` resolved,
there would be no record of it anywhere.

## Acceptance criteria

- [x] A telemetry report that 401s because no session exists yet is re-sent once
      a session is established, carrying the numbers captured at report time —
      not re-read at flush.
- [x] A report that 401s when a session *already* exists is re-sent immediately
      rather than queued, so a login landing between send and 401 cannot orphan
      it.
- [x] A silent mid-session refresh counts as establishing a session, so a report
      that 401s in the expired-`at` window is not orphaned for the tab's life.
- [x] A second 401 on the re-send is dropped, never re-queued.
- [x] The queue is capped, so a tab that is never logged into cannot grow it.
- [x] `installTiming()` does not fire on `/v/` or `/s/` loads, where nobody logs
      in and the queue could never drain.
- [x] The endpoints stay authenticated. No new unauthenticated write surface.

## Out of scope

Two production **config** items the same logs surfaced. Both are reported to the
operator, not fixed here:

1. The prod PayPal app is missing the **Disputes** permission — 8 ×
   `403 NOT_AUTHORIZED` on `GET /v1/customer/disputes`. It is a separate toggle
   from Transaction Search, and a dashboard change.
2. `SHIPPO_API_TOKEN` and `SHIPSAVING_APP_KEY`/`_SECRET` are unset in prod, so
   tracking never moves on its own and labels are canned demo data. The boot
   banner announces this on every restart.

Also out of scope: suppressing the *first* 401. The beacon tries, then holds.
Silencing it would mean plumbing auth state into two leaf modules, and the line
is honest — the report arrived before the session did. Fixing the loss is the
point, not the log line.

## Notes

The signal is a `auth:established` window event rather than a direct
`markSessionEstablished()` import, which would be better typed. `beacon.ts`
imports `rawFetch` from `api.ts`, so `api.ts` importing `beacon.ts` is a cycle —
which is the same reason `auth:unauthorized` is already an event. One mechanism
from all three dispatchers beat mixing a direct call with an event.

`beacon.ts` splits into a pure core plus a wired shell, the way `chunkReload.ts`
does, because the frontend vitest run has no DOM environment
(`apps/frontend/package.json` is a bare `vitest run`) — `window` and a real
`fetch` do not exist in a test. The core takes an injected `post`.
