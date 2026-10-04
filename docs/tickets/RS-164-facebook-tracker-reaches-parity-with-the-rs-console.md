---
id: RS-164
title: Facebook tracker reaches parity with the rs-console dashboard, including watching a worker's browser
type: story
status: done
priority: P2
created: 2026-10-04
reporter: Jinhu
branch: feat/fleet-console-parity
pr: 491
version: 1.204.0
related: [RS-048]
---

## Ask

> This is my erp system https://github.com/JinhuW/recycle_servres_erp.
>
> try to integrate the current consoel to the erp system.

(With a screenshot of the standalone rs-console fleet dashboard, console 0.5.5:
"Needs a human" panel, the accounts table with its Watch column.)

## Context

RS-048 (v1.140.0) ported the rs-console fleet dashboard into `/fleet` as it
stood in early September. The console has grown since: a "Needs a human" panel
that lists flagged accounts and not only checkpoints, an Account information
table, a "Listings reviewed today" KPI, a Re-login action, and — the one that
matters most — a **Watch** button that opens a worker's live Chromium through
the facade's VNC bridge.

Watch could not simply be linked. The facade's viewer authenticates with a
console token pasted into the browser on the facade's own origin, and the
tunnel hostname sits behind Cloudflare Access; an ERP manager has neither. The
ERP backend holds both credentials, so it relays the socket: the browser opens
a same-origin WebSocket with its session cookie, the backend admits it through
the normal middleware (proxy secret, auth, manager, Origin), mints the facade's
single-use ticket and pumps bytes.

## Acceptance criteria

- [x] `/fleet` shows a "Needs a human" card with open checkpoints (capture,
      Watch, Mark resolved) and flagged accounts with the reason, Watch, and
      Re-login where the session is the problem; hidden when nothing is flagged.
- [x] The accounts table has a Watch column for every worker the facade can
      bridge to (`vnc_live`), and the row detail links to it.
- [x] An Account information card lists every account's Facebook login, user
      id, worker, region, state, proxy, stored secrets, browser, backup age and
      session expiry.
- [x] The fourth KPI is listings reviewed today, as on the console.
- [x] `/fleet/watch/<worker>` shows the worker's live browser, view-only by
      default, with Take control, Re-login and Reconnect; a refusal from the
      facade (e.g. no VNC target) is shown in words.
- [x] The socket refuses no session, a non-manager, and a foreign Origin
      before any ticket is minted; the facade token and Access credentials
      never reach the browser.
- [x] `en` and `zh` strings are in parity.

## Out of scope

Any change to the facade itself — the routes used here (`/v1/vnc/<id>/ticket`,
the VNC socket, `/v1/workers/<id>/relogin`) all ship in console 0.5.5.

## Notes

- `@hono/node-ws` was not used: it replays the upgrade through the app with its
  own `env` (`{incoming}`), which would bypass `buildEnv()`. `vncBridge.ts`
  replays the handshake through `app.fetch(req, env)` instead, so the upgrade
  is gated by exactly the middleware every other request gets.
- Production needs the Cloudflare Worker to pass the upgrade through — it does,
  since `fetch(new Request(target, request))` keeps the Upgrade header.
- Verified end to end against the live homelab facade: mw-1's browser streamed
  into the ERP viewer; se-1 (no VNC target) reported its reason.
