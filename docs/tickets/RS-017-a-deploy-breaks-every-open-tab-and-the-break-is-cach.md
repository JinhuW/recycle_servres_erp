---
id: RS-017
title: a deploy breaks every open tab and the break is cached for a year
type: bug
status: in-review
priority: P1
created: 2026-09-03
reporter: Jinhu
branch: session/20260902-140951
pr: 250
version: 1.121.1
related: [RS-018]
---

## Ask

> ultrathink i feel sometime the page is loading slow. work as an architect.
> Think of how to optimize the page load speed. I feel it may realted to the
> backend.

> pls start the implementation to achive all of them,

## Context

The backend was ruled out by measurement.  Across ~10 days of production request
logs (1,168 non-health requests) every endpoint except OCR completes in under
224 ms, `/api/dashboard` averages 51 ms, and there was one container start and
one WARN in the whole window.  Direct probes: 28–36 ms of server time at the
Railway origin, ~76 ms through the Worker.

The worst thing on the client path is this one, and it is a correctness bug
rather than a slow path.  Chunk filenames are content-hashed, so a deploy
replaces the whole asset manifest.  A tab that was already open still references
the previous build's names, and requesting one of those returns:

    HTTP/2 200
    content-type: text/html
    cache-control: public, max-age=31536000, immutable

`not_found_handling = "single-page-application"` turns every miss under
`/assets/` into a hit on `index.html`, and the `_headers` `/assets/*` rule then
stamps that HTML as immutable for a year.  Three things follow.  The browser
tries to parse a document as an ES module, so `Suspense` never resolves and the
user watches a skeleton that never becomes a page — which is what "sometimes the
page loads slow" actually was.  The bad response is cached under that URL for a
year, so the failure outlives the deploy that caused it.  And because the asset
layer always finds a match, the Worker is never invoked for those paths, so the
http→https redirect never runs either — a missing asset is served over plain
http.

It is already happening to people.  From the production log, 2026-09-03 15:58,
on `#/purchase-orders/PO-1416`:

    [WARN] Failed to fetch dynamically imported module:
      /assets/DesktopEditOrder-Bk3JVlCu.js

The running build at the time was `index-BflUPgR4.js`; the deployed one was
`index-Chpst3jI.js`.

## Acceptance criteria

- [x] A request for a content-hashed asset that no longer exists returns `404`,
      not `200 text/html`.  Verified against `wrangler dev` on a real build for
      `/assets/`, `/fonts/` and `/icons/`.
- [x] The SPA fallback still works for every real document path: `/`,
      `/authorize`, `/v/<token>`, `/s/<token>`, the PWA manifest shortcuts, and
      any unknown path.  All return `200 text/html` with `no-cache`.
- [x] A tab whose chunk has been deployed away reloads itself once and lands on
      the current build, instead of stalling on a skeleton.
- [x] The reload cannot loop: a second failure inside the 60s guard window falls
      through to the existing ErrorBoundary.  Covered by `chunkReload.test.ts`.
- [ ] A missing asset requested over plain http is redirected to https rather
      than answered directly.  **Open** — depends on whether Cloudflare invokes
      the Worker for a genuine miss on a `run_worker_first`-excluded prefix;
      locally it does not.  Measure on dev.
- [ ] The 404 is not cached.  **Open, and weaker than first written.**  Because
      the asset layer answers it without invoking the Worker, the 404 still
      picks up `immutable, max-age=1y` from the `_headers` `/assets/*` rule.
      Harmless while chunk hashes never recur — the URL is never requested
      again — but a revert that reproduces a hash would find a cached 404.
      Measure the real Cloudflare behaviour on dev before deciding whether this
      needs more than a comment; the alternative costs a Worker invocation on
      every asset request, which is the opposite of the goal.

## Out of scope

The other findings from the same investigation — access-token lifetime, the
boot-time preload/prefetch, a shared warehouses cache, and client timing
telemetry — are RS-018.  This ticket is the correctness bug only, so it can ship
on its own.

## Notes

The fix starts in `wrangler.toml`, not in `worker.js`.  `run_worker_first`
excludes `/assets/*`, `/fonts/*` and `/icons/*` so hashed assets stay on the
free path, and with SPA `not_found_handling` the asset layer always matches —
so a Worker-side check would never execute.  Verified over plain http against
production: `/` returns the Worker's 308, while `/assets/nope-12345678.js` and
`/fonts/nope.woff2` return 200 with no redirect.

Setting `not_found_handling = "none"` moves ownership of the SPA fallback to the
Worker, which is why the acceptance criteria list the document paths explicitly.

Client-side recovery rides on Vite's own `vite:preloadError` event rather than
wrapping each `lazy(() => import(...))` factory — `__vitePreload` already
catches every failed dynamic import, so one listener covers all 32 call sites
and any added later.
