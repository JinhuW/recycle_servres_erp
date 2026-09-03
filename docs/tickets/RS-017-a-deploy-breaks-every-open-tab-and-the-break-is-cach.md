---
id: RS-017
title: a deploy breaks every open tab and the break is cached for a year
type: bug
status: done
priority: P1
created: 2026-09-03
reporter: Jinhu
branch: session/20260902-140951
pr: 250
version: 1.121.1
related: [RS-019]
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
- [x] A missing asset requested over plain http is not answered with content.
      Measured on dev: it returns `404` directly rather than the Worker's 308,
      because Cloudflare does not invoke the Worker for a miss on a
      `run_worker_first`-excluded prefix.  Closed as written rather than as
      first drafted — the original wording asked for a redirect, but a 404
      carries nothing worth protecting, and the scheme bug this echoes was about
      a *document* being served over http.
- [x] The 404 is not cached — **accepted as-is, with reasoning.**  Measured on
      dev: it still carries `immutable, max-age=1y`, because the asset layer
      answers it and `_headers` applies.  Left alone deliberately.  The only
      ways to change it are routing `/assets/*` through the Worker, which adds
      an invocation to every asset request and works against the reason this
      work exists, or dropping the immutable rule, which gives up the caching.
      And the cached 404 is close to unreachable: only a page from the build
      that referenced that filename ever requests it, and such a page now
      reloads itself onto the current build on the first failure.  Revisit only
      if a recurring chunk hash is ever actually observed.

## Out of scope

The other findings from the same investigation — access-token lifetime, the
boot-time preload/prefetch, a shared warehouses cache, and client timing
telemetry — are RS-019.  This ticket is the correctness bug only, so it can ship
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

Verified on dev after #250 merged and the Worker auto-deployed (919a2d1).  The
exact URL from the production report now behaves:

    GET /assets/DesktopEditOrder-Bk3JVlCu.js   →  404      (was 200 text/html)
    GET /assets/index-<current>.js             →  200 text/javascript
    GET / /authorize /v/<token> /submit        →  200 text/html, no-cache
