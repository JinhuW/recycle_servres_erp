# A blank prod page after a deploy was a cached 404, not the "503 rate limit" the report described

**Symptom.** Right after the v1.238.1 prod release, one user's tab on
inventory.recycleservers.com went blank and stayed blank across reloads.  A
DevTools write-up came with it: lazy chunks (`DesktopApp-…js`,
`RolePicker-…js`, `PwaUpdateToast-…js`) and `POST /api/client-errors` were
said to "fail with 503 under burst load", and nginx `limit_req` was the
suggested culprit.  The same files returned 200 when fetched one at a time.

## What it was not

- **Not a rate limiter.**  Prod has no nginx.  `/assets/*` is answered by
  Cloudflare's Workers static-asset layer, and the Cloudflare analytics for the
  host had **no 503 at all** in the window.
- **Not the backend.**  The backend accepted every `client-errors` POST from
  that user with `204`, and `/api/me` answered `200` in the same seconds.
- **Not a client reload loop.**  The repeated loads were `navType: reload` (46
  of 55, from `client timing` log lines).  `lib/chunkReload.ts` allows one
  automatic reload per minute per tab.  The rest were the user's own reloads.
- **Not a missing build.**  The three files returned `200` at the edge for
  everyone else.  That ruled out a stale tab or service worker asking for an old
  build's names: these were the *current* build's chunks.

"503" in the write-up was never reproduced anywhere.  Don't chase it.

## Root cause

A deploy reaches the edge unevenly.  For a few seconds the new `index.html` can
be served while a request for one of its chunks lands on a node still holding
the old manifest.  The asset layer answered that miss itself, and the
`_headers` `/assets/*` rule was applied to the 404 as well:

```
HTTP/2 404
content-length: 0
cache-control: public, max-age=31536000, immutable
```

The browser cached "this chunk doesn't exist" for a year.  Every reload then
served the 404 from cache without touching the network, so the chunk's real
`200` on the edge could never reach that user.  Cloudflare's analytics showed
exactly this: **one** `404` each for the three chunks, `cacheStatus: none`, and
then no further requests from that client.

The page was blank, not the error card, because the update-toast `<Suspense>`
in `App.tsx` sat outside `<ErrorBoundary>`.  The toast chunk was one of the
cached 404s, and React 18 unmounts the whole root on an error no boundary
catches.

## How to tell quickly

```bash
# What a miss looks like at the edge — the cache-control is the tell
curl -sI https://inventory.recycleservers.com/assets/DoesNotExist-x.js
```

In the affected browser's console, check whether the 404 is coming from cache:

```js
performance.getEntriesByType('resource')
  .filter(e => e.name.includes('/assets/'))
  .map(e => [e.responseStatus, e.deliveryType, e.transferSize, e.name])
// 404 · "cache" · 0  ⇒ a cached miss, not a live failure
```

Evidence sources that settled it:

- Cloudflare GraphQL `httpRequestsAdaptiveGroups` filtered by host and
  `edgeResponseStatus`, using the `wrangler login` OAuth token, which has
  `zone:read`.
- The `client-error` and `client timing` lines in the Railway backend log.
  Read them per deployment (`railway logs … <deploymentId>`).

## Fix (RS-221, v1.238.2)

- `wrangler.toml`: `run_worker_first = true`.  Every miss now reaches the
  Worker's `no-store` 404.  Hits still come from `env.ASSETS.fetch` with
  `_headers` applied.  `tests/unknown-path-404.test.ts` fails if a `!/…`
  exclusion comes back.
- `App.tsx`: the toast is wrapped in `<ErrorBoundary fallback={null}>`, so a
  failed toast load can't blank the app.
- A browser that already holds such a 404 needs its cache emptied.  The server
  fix doesn't reach a response the browser never re-requests.  Use DevTools →
  right-click reload → *Empty Cache and Hard Reload*.

## Lesson

A premise like "only an old page ever requests a missing hash" (RS-017) ignores
deploy skew.  A new page can request its own files before they exist where it
looks.  Never let a caching rule written for hits also apply to misses.
