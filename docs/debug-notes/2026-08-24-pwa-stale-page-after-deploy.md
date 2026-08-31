# "Old page after deploy" is the service worker, not Cloudflare (2026-08-24)

## Symptom

After a frontend deploy, some sessions — including **desktop** ones — kept
showing the previous build (reported on the shipping page). Cloudflare looked
like the suspect but was innocent: `index.html` ships `Cache-Control: no-cache`
and `/assets/*` are content-hashed + immutable, so the CF edge can never serve
a stale build. Verified live with `curl -I` before touching anything.

## Root cause

The Workbox service worker (`apps/frontend/src/sw.ts`) precaches the entire
app shell and answers navigations from the precache. Updates are **prompt-mode**
by design (`registerType: 'prompt'` — a deploy must never reload mid-session),
so the new build only applies when the user taps the update toast. Three gaps
kept that tap from ever happening:

1. **Missed event**: `pwa:needRefresh` was a one-shot `CustomEvent`, but the
   toast (`PwaUpdateToast`) is lazy-loaded. With a new SW *already waiting*
   from a previous session, workbox fires `onNeedRefresh` at registration —
   before the toast's listener mounts. Event lost, no prompt all session.
2. **Dismissal was permanent**: closing the toast left no way to re-prompt
   until the next full relaunch.
3. **Desktop trap**: `registerPwa()` no-ops at `innerWidth >= 720` and the
   toast only mounts on the phone shell — but a SW registered during any
   narrow-width visit (Chrome device emulation is enough) still *controls*
   later desktop loads and serves its precached build, with no update path
   at all. This is why "old page" appeared on desktop despite PWA being
   mobile-only.

## Fix (v1.86.1, PR #169)

- `lib/pwa.ts` keeps a module-level `pwaUpdatePending()` flag; the toast reads
  it as initial state instead of relying on the one-shot event.
- The toast re-opens on `visibilitychange` while an update is pending —
  dismissal is a snooze, not a decline.
- At desktop width, `registerPwa()` unregisters any existing SW registration.
  The already-loaded page stays SW-served (can't be swapped mid-flight); the
  next load hits the network.

## Traps for next time

- A stale-UI report can **never** be Cloudflare here: check
  `navigator.serviceWorker.getRegistrations()` / DevTools → Application → SW
  first. `cf-cache-status: HIT` on a hashed asset is normal and harmless.
- Prompt mode means a waiting SW activates only on user tap **or** when the
  last client closes. "Sometimes stale" = the sessions in between.
- Device-emulation testing on desktop Chrome registers the mobile-only SW for
  the real desktop profile — that's how desktop got a SW in the first place.
