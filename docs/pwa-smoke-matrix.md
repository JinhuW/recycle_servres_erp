# PWA smoke matrix

Run this matrix before each release that touches `vite.config.ts`,
`Caddyfile`, `apps/frontend/index.html`, `apps/frontend/public/icons/*`,
or anything under `apps/frontend/src/lib/pwa.ts`.

> **Scope:** PWA is mobile-only. The Desktop Chrome column is kept for table symmetry and marked n/a throughout.

| Check                                                       | Android Chrome | iOS Safari | Desktop Chrome |
|-------------------------------------------------------------|----------------|------------|----------------|
| Lighthouse PWA "Installable" passes                         | n/a            | n/a        | n/a            |
| Install prompt / Add-to-Home-Screen works                   |                |            | n/a            |
| Launches in standalone (no browser chrome)                  |                |            | n/a            |
| Home-screen icon is the correct (maskable / apple-touch)    |                |            | n/a            |
| Reload after deploy picks up new SW within one refresh      |                |            | n/a            |
| Offline reload of `/` shows the SPA shell (not browser err) |                |            | n/a            |
| Vendor portal `/v/<token>` is NOT SW-controlled             |                |            | n/a            |
| Background upload retries on flaky network (Task 10)        |                |            | n/a            |
| Share-from-Camera-Roll opens the AI label flow (Task 11)    |                |            | n/a            |

All matrix rows above are **pending real-device verification** as of the
last automatable check. None of them can be exercised without an Android
phone (Chrome), an iOS phone (Safari), or a desktop Chrome with Lighthouse,
all of which are unavailable from the headless dev environment that
produced this commit.

Rows tied to later milestones (Task 10 background sync, Task 11 share
target) will remain "n/a" until those tasks ship.

## Automatable pre-deploy checks

These can run in CI or locally without a real device. Results from last
run on 2026-06-02 (commit `7f34c20`):

- `pnpm --filter recycle-erp-frontend build` — succeeds; emits
  `dist/sw.js`, `dist/manifest.webmanifest`, and
  `dist/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon-180}.png`.
  vite-plugin-pwa reports `precache 20 entries (1444.94 KiB)`.
- Manifest JSON valid: `python3 -m json.tool < apps/frontend/dist/manifest.webmanifest`
  exits 0.
- Manifest top-level keys present: `background_color`, `description`,
  `display`, `icons`, `lang`, `name`, `orientation`, `scope`,
  `share_target`, `short_name`, `shortcuts`, `start_url`, `theme_color`.
- `manifest.icons` has 3 entries with purposes `any`, `any`, `maskable`
  (`/icons/icon-192.png`, `/icons/icon-512.png`,
  `/icons/icon-maskable-512.png`).
- `manifest.shortcuts` has 3 entries pointing at `/submit`, `/inventory`,
  `/sell-orders`.
- `manifest.share_target.action === "/share-target"`.
- `sw.js` contains the background-sync queue name
  `recycle-erp-attachments`, the share-target client/SW wire constants
  `pwa:claimSharedFile` and `pwa:sharedFile`, the `/share-target` route
  handler, and the injectManifest precache list (the `__WB_MANIFEST`
  placeholder was replaced — no literal `__WB_MANIFEST` remains in the
  bundle).
- `sw.js` precache list contains 20 entries; none match the forbidden
  prefixes `^/api/`, `^/v/`, `^/oauth/`, or `^/\.well-known/` (verified
  by extracting every `"url":"…"` entry and pattern-matching in Python →
  zero matches).
- `sw.js` `NavigationRoute` denylist literal is exactly
  `[/^\/v\//,/^\/api\//,/^\/oauth\//,/^\/\.well-known\//,/^\/share-target$/]`
  — the four backend/portal patterns plus the share-target route, all
  present.
- `sw.js` does NOT contain the substring `apple-splash` — the 20 iOS
  splash PNGs in `dist/icons/` are intentionally excluded from precache
  (Task 12 follow-up; saves ~10 MB of install-time downloads).
- `sw.js` also installs `NetworkOnly` route handlers for `/api/`,
  `/oauth/`, and `/.well-known/` so those paths bypass any cache even if
  the navigation denylist is ever bypassed.
- All four functional icon assets (`icons/icon-192.png`,
  `icons/icon-512.png`, `icons/icon-maskable-512.png`,
  `icons/apple-touch-icon-180.png`) appear in the precache list; the 20
  `icons/apple-splash-*.png` files are present on disk but not precached.
- `apps/frontend/src/lib/pwa.ts` retains the `window.innerWidth >= 720`
  early return so install/SW/share-target wiring is mobile-only (Task
  11b).
- Caddyfile validates:
  `docker run --rm -v $(pwd)/apps/frontend/Caddyfile:/etc/caddy/Caddyfile caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
  reports `Valid configuration`.

### Deferred steps

Desktop checks deferred / not applicable; the only audit target is the
mobile shell. The following steps from the M5 plan require hardware the
dev environment does not have and must be run by a human before release
cut:

- Android Chrome install + standalone launch (Step 7.3).
- iOS Safari Add-to-Home-Screen + standalone launch (Step 7.4).

## M10 final close-out checklist (user-driven)

These steps require physical devices and can't be automated from CI. Run before
declaring the PWA close-out complete:

- [ ] **Android Chrome install**: open the deployed app on a real Android phone,
      install via the install icon / "Install app" CTA, launch the installed
      shortcut, confirm standalone mode (no browser chrome), confirm the home-
      screen icon is the maskable variant (rounded square, no hexagon-tip clip).
- [ ] **iOS Safari install**: open in Safari, Share → Add to Home Screen, kill
      Safari, relaunch from the home-screen icon, confirm the apple-touch-icon
      shows and a non-white splash renders.
- [ ] **Lighthouse PWA audit** (mobile): run against the deployed mobile preview.
      "Installable" must pass. "Fast and reliable" must pass.
- [ ] **Update flow**: deploy a tiny change, reload the installed PWA, confirm
      the update toast appears, tap Reload, confirm new SW takes over.
- [ ] **Offline shell**: with the PWA installed, go offline, reload `/` — must
      render the SPA shell, not the browser's offline error page.
- [ ] **Vendor portal not SW-controlled**: open `/v/<a-test-token>` on a real
      device, DevTools Application → Service Workers — no SW should claim the
      page. (Automatable check confirms it's excluded from precache + denylist;
      this verifies the runtime behavior.)
- [ ] **Background-sync upload**: install on a real device, switch to airplane
      mode, take a label photo via the AI capture flow, exit and re-enter the
      app, toggle airplane mode off, confirm the upload completes silently and
      the attachment appears on the order.
- [ ] **Web Share Target**: from the camera roll, Share → Recycle ERP, confirm
      the PWA opens at `/submit` and (on desktop install only) the shared photo
      is pre-loaded into the AI label dropzone. Mobile install just lands on
      `/submit`; manual AI capture follows.

When all eight pass, M10 is closed.
