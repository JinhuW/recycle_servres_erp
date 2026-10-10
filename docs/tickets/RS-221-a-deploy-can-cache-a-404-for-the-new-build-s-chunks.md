---
id: RS-221
title: a deploy can cache a 404 for the new build's chunks, blanking prod
type: bug
status: done
priority: P1
created: 2026-10-09
reporter: Jinhu
branch: fix/asset-404-no-store
pr: 585
version: 1.238.2
related: [RS-017]
---

## Ask

> The page is showing this:
>
> ## Bug: inventory.recycleservers.com shows a blank white page in production
>
> ### Symptoms
> - Page renders blank. Nothing visible, no error UI.
> - Console repeats the same errors many times per second, which looks like a reload/retry loop. Over 500 requests piled up in about a minute:
>   TypeError: Failed to fetch dynamically imported module: /assets/DesktopApp-c2Dk-QF-.js
>   [render] TypeError: Failed to fetch dynamically imported module: /assets/DesktopApp-c2Dk-QF-.js
>       at Lazy
>       at Suspense
>       (index-D6kwwgVn.js:41)
>   TypeError: Failed to fetch dynamically imported module: /assets/PwaUpdateToast-UUlrKERk.js  (uncaught exception)
>
> ### Network evidence (Chrome DevTools)
> Initial requests all succeed (200):
>   /, /assets/boot-B6Hqj-sT.js, /assets/index-D6kwwgVn.js, /assets/index-DIFcWvgT.css,
>   /assets/pwa-BaxqfLem.css, /fonts/*.woff2, /sw.js, /api/me, /api/lookups, /api/workspace
> The burst of lazy-chunk requests that follows fails with **503**:
>   GET  /assets/DesktopApp-c2Dk-QF-.js       -> 503
>   GET  /assets/RolePicker-CtL7BTFB.js       -> 503
>   GET  /assets/PwaUpdateToast-UUlrKERk.js   -> 503
>   POST /api/client-errors                    -> 503
> The same files return 200 when fetched one at a time a moment later (DesktopApp 38KB,
> PwaUpdateToast 2.3KB, index 311KB, all text/javascript). So the files exist and the build is
> not missing chunks. The server or proxy is rejecting them intermittently under burst load.
>
> ### Likely causes (check in this order)
> 1. Rate limiting on the reverse proxy. nginx `limit_req` returns 503 by default. A page load
>    fires about 10+ parallel requests, and the lazy chunks land past the burst limit.
>    Fix: exempt /assets/, /fonts/, /icons/ and other static files from limit_req, or raise
>    burst and add `nodelay`. Consider `limit_req_status 429`.
> 2. A reload/retry loop on chunk-load errors, such as a vite:preloadError or lazy() catch
>    that calls location.reload(). Each reload adds more requests and keeps tripping the
>    limiter, so the page never recovers. Fix: reload at most once, guarded with a
>    sessionStorage flag.
> 3. A missing error boundary around <Suspense>/lazy routes. A failed chunk should show a
>    "Failed to load, Retry" UI instead of a blank screen.
> 4. The PwaUpdateToast import is not caught, which causes the uncaught exception. Wrap it
>    in try/catch or lazy with a fallback.
> 5. Less likely: the service worker (/sw.js) or an upstream such as Cloudflare or a
>    container health check returning 503 while the backend restarts. Check the proxy
>    access/error logs for 503s on /assets/*.
>
> ### Asks
> - Find where the 503 is generated (nginx/caddy/cloudflare config or app server static
>   handler) and stop rate-limiting static assets.
> - Add a one-time reload guard plus an error boundary for lazy chunk failures.
> - Verify: hard reload the page and confirm that no /assets/* request returns 503.

## Context

There was no 503 and no rate limiter.  Production has no nginx in front of it:
`/assets/*` was answered by Cloudflare's Workers static-asset layer directly.
Cloudflare's analytics for the host from 00:10 to 00:40 UTC show no 503 at all.
They do show one `404` each, `cacheStatus: none`, at BOS, for exactly the three
chunks in the report.  After that there were no more requests for those paths
from that client.  The backend accepted all 47 of that user's `client-errors`
reports with `204`, and its `/api/me` answered `200` in the same seconds.  The
repeated loads were `navType: reload` (46 of 55).  The existing
`chunkReload` guard allows one reload per minute per tab, so the rest were the
user's own reloads, not a loop.

The 404s came from the v1.238.1 prod Worker deploy (00:15:10–00:16:02 UTC).  A
deploy is not atomic across the edge.  The new `index.html` was served while the
request for one of its chunks reached an asset node still on the old manifest.
That node returned a 404 for a filename that is *current*.  The asset layer
answered the miss itself, and the `_headers` `/assets/*` rule stamped it:

    HTTP/2 404
    content-length: 0
    cache-control: public, max-age=31536000, immutable

So the browser cached "this chunk does not exist" for a year.  Reproduced in
Chrome: after one real 404, every later `fetch` and `import()` of that URL comes
from the HTTP cache (`transferSize 0`, `deliveryType: cache`) and throws
`Failed to fetch dynamically imported module`.  A reload never reaches the
network again, and the chunk's own `200` on the edge doesn't help.

RS-017 accepted that cached 404 because "only a page from the build that
referenced that filename ever requests it".  It said to revisit if a recurring
hash were ever observed.  The deploy-skew window breaks that premise: a page
from the *new* build can request its own chunk before the edge it reaches
holds it.

The page was blank rather than showing the error card for a second reason.  In
`App.tsx` the update-toast `<Suspense>` sits outside `<ErrorBoundary>`, and its
chunk was one of the cached 404s.  On React 18 an error no boundary catches
unmounts the whole root, taking the boundary's "Reload" card with it.  That is
the "(uncaught exception)" line.

## Acceptance criteria

- [x] A missing `/assets/`, `/fonts/` or `/icons/` file returns `404` with
      `Cache-Control: no-store`, checked with curl on dev.
- [x] A real hashed asset still returns `200` + `immutable`, and a conditional
      request still `304`s (dev).
- [x] A plain-http asset request `308`s to https (dev).
- [x] A toast chunk that fails to load leaves the app rendered, checked on a
      local build with the chunk deleted.  A shell chunk that fails shows the
      "Something went wrong / Reload" card, not a white page.
- [x] `wrangler.toml` routing an asset prefix past the Worker again fails a test.

## Out of scope

- The one-time reload guard and the shell error boundary the report asks for
  already exist (`lib/chunkReload.ts`, `components/ErrorBoundary.tsx`, both
  from RS-017).
- A client-side cache-busting retry.  It can only re-request the top-level URL.
  The shell's own static imports (RolePicker) and the boot script's
  `modulepreload` would still hit the cached 404.
- A zone-level header rule for 404s.  It would live outside the repo, and
  `_headers` is meant to be the one place these headers are set.

## Notes

The fix is `run_worker_first = true`.  Every request now runs the Worker, so a
miss under a static prefix reaches its existing `no-store` 404 branch, which was
dead code until now.  Hits still come from `env.ASSETS.fetch`, and `_headers`
still applies to them.  This was checked on prod before the change: `/sw.js`,
which already went through the Worker, carries `no-cache` and HSTS from
`_headers`.  A response the Worker builds itself (`/fleet`'s 404) keeps its own
headers.  The cost is about 725 static requests a day that now invoke the Worker,
on top of about 3.7k a day that already do, across all three hosts.  The first
load only, because hashed assets stay in the browser cache.

See `docs/debug-notes/2026-10-10-deploy-skew-caches-a-404-for-the-new-chunk.md`.

Verified on dev after #585 merged (v1.238.2, `bf341153`), with the Worker
auto-deployed:

    GET /assets/nope-zz9q.js, /fonts/nope.woff2, /icons/nope.png
        →  404 text/plain, cache-control: no-store
    GET /assets/index-<current>.js   →  200, public, max-age=31536000, immutable
    GET /icons/icon-192.png          →  200, public, max-age=86400
    If-None-Match on a chunk         →  304
    http://…/assets/index-<current>.js  →  308 to https

A browser load of dev showed every `/assets/` request answered `200`.
