---
id: RS-167
title: Unknown paths return 404 instead of the app shell
type: bug
status: done
priority: P2
created: 2026-10-04
reporter: jinhu
branch: fix/unknown-path-404
pr:
version: 1.206.1
related: []
---

## Ask

> for all not available route, the page should return 404 instead of a readom page.
>
> https://inventory.recycleservers.com/vnc/homelab-1#/fleet
>
> It is not available, but you still show the other page content

## Context

The app is hash-routed, but the Cloudflare Worker answered every non-API,
non-asset path with `index.html` (200). The hash then picked the screen, so
`/vnc/homelab-1#/fleet` — a path that exists only on rs_console — rendered the
ERP's Fleet page as if the URL were valid. The service worker's
`NavigationRoute` did the same from its precache for installed clients, so a
Worker fix alone would not reach them.

The app shell only ever lives at a handful of real paths: `/`, `/authorize`
(OAuth consent), `/share-target` (Web Share Target landing) and the PWA
manifest shortcuts `/submit`, `/inventory`, `/sell-orders`.

## Acceptance criteria

- [x] A GET for a path outside that list returns 404 with a small "Page not
      found" HTML page linking home, whatever the hash.
- [x] `/`, `/authorize`, `/share-target`, `/submit`, `/inventory`,
      `/sell-orders` still serve the app shell.
- [x] Real static files (`/sw.js`, `/manifest.webmanifest`, …) and `/api/*`
      are unchanged.
- [x] The service worker only falls back to the cached shell for the same
      allowlist, so installed clients see the 404 too.

## Out of scope

The self-hosted Caddyfile stack (retired 2026-07-12) keeps its
`try_files` fallback.

## Notes

The allowlist lives in `apps/frontend/src/lib/shellPaths.ts`, imported by both
`deploy/cloudflare/worker.js` (wrangler bundles it) and `src/sw.ts`, so the two
cannot drift. `/v/<token>` and `/s/<token>` (retired portals) are not on it:
the frontend has no route for either. Verified with `wrangler dev`: shell paths
200, `/vnc/homelab-1`, `/fleet`, `/asdf/qwe` 404, `/sw.js` and the manifest 200.

