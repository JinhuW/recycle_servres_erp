# PWA smoke matrix

Run this matrix before each release that touches `vite.config.ts`,
`Caddyfile`, `apps/frontend/index.html`, `apps/frontend/public/icons/*`,
or anything under `apps/frontend/src/lib/pwa.ts`.

| Check                                                       | Android Chrome | iOS Safari | Desktop Chrome |
|-------------------------------------------------------------|----------------|------------|----------------|
| Lighthouse PWA "Installable" passes                         | n/a            | n/a        |                |
| Install prompt / Add-to-Home-Screen works                   |                |            |                |
| Launches in standalone (no browser chrome)                  |                |            |                |
| Home-screen icon is the correct (maskable / apple-touch)    |                |            |                |
| Reload after deploy picks up new SW within one refresh      |                |            |                |
| Offline reload of `/` shows the SPA shell (not browser err) |                |            |                |
| Vendor portal `/v/<token>` is NOT SW-controlled             |                |            |                |
| Background upload retries on flaky network (Task 10)        |                |            |                |
| Share-from-Camera-Roll opens the AI label flow (Task 11)    |                |            |                |

All matrix rows above are **pending real-device verification** as of the
last automatable check. None of them can be exercised without an Android
phone (Chrome), an iOS phone (Safari), or a desktop Chrome with Lighthouse,
all of which are unavailable from the headless dev environment that
produced this commit.

Rows tied to later milestones (Task 10 background sync, Task 11 share
target) will remain "n/a" until those tasks ship.

## Automatable pre-deploy checks

These can run in CI or locally without a real device. Results from last
run on 2026-06-01 (commit `5d05b3e`):

- `pnpm --filter recycle-erp-frontend build` — succeeds; emits
  `dist/sw.js`, `dist/workbox-24218c68.js`, `dist/manifest.webmanifest`,
  and `dist/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon-180}.png`.
  vite-plugin-pwa reports `precache 20 entries (1436.04 KiB)`.
- Manifest JSON valid: `python3 -m json.tool < apps/frontend/dist/manifest.webmanifest`
  exits 0.
- Manifest top-level keys present: `background_color`, `description`,
  `display`, `icons`, `lang`, `name`, `orientation`, `scope`,
  `short_name`, `shortcuts`, `start_url`, `theme_color`.
- `manifest.icons` has 3 entries with purposes `any`, `any`, `maskable`.
- `manifest.shortcuts` has 3 entries pointing at `/submit`, `/inventory`,
  `/sell-orders`.
- `sw.js` precache list contains 20 entries; none have a URL matching
  `/api/` or `/v/` prefixes (verified via
  `grep -oE '\{url:"[^"]+"' dist/sw.js | grep -E '"/?(api|v)/'` → no
  matches).
- `sw.js` `NavigationRoute` denylist literal is exactly
  `[/^\/v\//,/^\/api\//,/^\/oauth\//,/^\/\.well-known\//]` — all four
  expected regexes present.
- `sw.js` also installs `NetworkOnly` route handlers for `/api/`,
  `/oauth/`, and `/.well-known/` so those paths bypass any cache even if
  the navigation denylist is ever bypassed.
- All four icon assets (`icons/icon-192.png`, `icons/icon-512.png`,
  `icons/icon-maskable-512.png`, `icons/apple-touch-icon-180.png`) appear
  in the precache list.
- Caddyfile validates:
  `docker run --rm -v $(pwd)/apps/frontend/Caddyfile:/etc/caddy/Caddyfile caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
  reports `Valid configuration`.

### Deferred steps

The following steps from the M5 plan require hardware or a browser the
dev environment does not have and must be run by a human before release
cut:

- Lighthouse PWA audit on desktop Chrome (Step 7.2).
- Android Chrome install + standalone launch (Step 7.3).
- iOS Safari Add-to-Home-Screen + standalone launch (Step 7.4).
