---
id: RS-019
title: the cold load waits on a token refresh and a serial chunk hop
type: task
status: done
priority: P2
created: 2026-09-03
reporter: Jinhu
branch: session/20260902-140951
pr: 252
version: 1.122.0
related: [RS-017]
---

## Ask

> ultrathink i feel sometime the page is loading slow. work as an architect.
> Think of how to optimize the page load speed. I feel it may realted to the
> backend.

> pls start the implementation to achive all of them,

## Context

Second half of the page-load work.  [RS-017] fixed the correctness bug that made
a deploy break open tabs; this ticket is the everyday cold load.

The backend was ruled out by measurement — across ~10 days of production request
logs every endpoint except OCR completes in under 224 ms, `/api/dashboard`
averages 51 ms, `/api/me` 23 ms.  What costs the user time is all on the client:

**A refresh round trip before the first pixel, on most loads.**  `/api/lookups`
and `/api/workspace` each fired 23 times in the window — both are module-cached,
so that is 23 app mounts — while `/api/auth/refresh` fired **19** times, with 38
accompanying 401s.  The `at` cookie lives 15 minutes, so a user returning after
a break goes: three bootstrap calls, all 401 → refresh (88 ms) → three retries.
`AuthProvider` gates render on `Promise.all` of the three, so that is three
serial round trips of blank screen.  Caught live in the log:

    17:41:42.388  401  /api/shipments
    17:41:42.390  401  /api/packages
    17:41:42.553  200  /api/auth/refresh   88ms
    17:41:42.612  200  /api/packages       (retry)

**A serial chunk hop nothing preloads.**  `index.html` → entry JS (87 KB brotli,
255 KB raw to parse) → the shell chunk → mount → `/api/dashboard`.  The shell is
chosen at runtime by viewport width, so Vite cannot emit a static
`modulepreload` for it and the browser only learns it needs `DesktopApp-*.js`
after parsing a quarter-megabyte of JavaScript.

**Reference data with no client cache.**  `/api/warehouses` has ten GET call
sites across nine components, each with its own `useEffect`.  In one real
session it fired six times in 1.6 s.  `lib/lookups.ts` and `lib/workspace.ts`
already implement the single-flight module cache this wants.

**No way to tell whether any of this helped.**  There is a client *error* sink
(`/api/client-errors`) but no client *timing* one, which is why the original
report could only be "sometimes it feels slow".

## Acceptance criteria

- [x] The `at` cookie and its JWT both live 60 minutes, and every comment or doc
      that quotes 15 minutes is updated.
- [x] `/api/me`, `/api/lookups` and `/api/workspace` are in flight before the
      entry bundle finishes parsing, and the shell chunk is preloaded alongside
      them rather than discovered after.
- [x] A prefetch that comes back 401 costs nothing extra — the normal
      `api.get` path still refreshes and retries.
- [x] The vendor (`/v/`) and seller (`/s/`) portals prefetch nothing: different
      shells, different endpoints.
- [x] Dev still works: no bundle means no injected script and every consumer
      takes its existing path.
- [x] `/api/warehouses` is fetched once per session, not once per component, and
      editing a warehouse in Settings still shows the edit immediately.
- [x] The SPA reports navigation timing and LCP once per load, so the effect of
      all of the above is measurable rather than felt.

## Out of scope

Painting the app before `/api/lookups` resolves.  It was in the first draft of
the plan and the review killed it: `lib/lookups.ts` has no subscription
mechanism, 24 files read `catalog.*` / `categories` / `sellOrderStatuses` as
plain module arrays during render, and `login()` deliberately awaits
`loadLookups()` before `setUser` for exactly that reason.  Painting early would
render empty dropdowns that only correct themselves on an unrelated re-render.
The boot prefetch makes it unnecessary anyway — the three calls start before the
entry parses, so waiting for the slowest of three parallel ~50 ms calls costs
single-digit milliseconds.

Adding `userId` to the request log line.  Already there: 353 request lines carry
it, and the ones without are `/api/health`, `/`, WordPress scanner probes and
`/api/auth/refresh`.

## Notes

The 60-minute lifetime is a deliberate, approved relaxation — Jinhu chose it
over 30 minutes and over leaving it alone.  `authMiddleware` re-checks
`active = TRUE` on every request, so deactivating a user still takes effect
immediately; what grows is the window in which a stolen cookie is usable, and
the rotating refresh family with reuse-revocation is what actually bounds that.

The preload and the prefetch have to ship together.  Today they already overlap
each other, so either one alone saves far less than the pair.

The boot script is emitted as a content-hashed asset rather than inlined:
`_headers` already marks `/assets/*` immutable, and `apps/frontend/Caddyfile`
sets `script-src 'self'` with no `'unsafe-inline'`, which would block an inline
tag under the Docker stack.

## Notes on what shipped

The boot script is a blocking classic `<script>` in `head-prepend`, so it is
guaranteed to run before the deferred module entry — which is what makes
`window.__boot` reliably present when `AuthProvider` reads it.  An `async`
script would have raced the entry and produced duplicate fetches on the loads
where it lost.

That costs one round trip before the prefetch starts (the browser must fetch
boot.js first), rather than the zero an inline script would cost.  Inlining was
rejected: `apps/frontend/Caddyfile` sets `script-src 'self'` with no
`'unsafe-inline'`, and pinning a CSP hash that changes with every build is a
silent-failure mechanism — the prefetch would just stop working under the Docker
stack with nothing to show for it.  The parser block is not a real cost either
way, because the preload scanner still discovers the CSS, fonts and entry ahead
of it.

Preload counts differ sharply by shell: desktop preloads 4 files, mobile 26.
That is not asymmetry in the plan — those are each shell's own first-level
static imports, which have to load before the shell can execute regardless.
Preloading them parallelises a graph that was previously walked one hop at a
time; the bytes are identical.
