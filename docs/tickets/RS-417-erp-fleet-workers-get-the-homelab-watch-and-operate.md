---
id: RS-417
title: ERP-fleet workers get the homelab watch-and-operate page
type: story
status: backlog
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet/watch-page-parity
pr:
version:
related: [RS-394, RS-416]
---

## Ask

> check the legacy worker operation, follow the same pattern: page for watch and operate.

## Context

A homelab (coordinator) worker has a watch page at `/fleet/watch/<id>`
(`FleetWatch.tsx`): the live Chromium over noVNC, Take control, Re-login,
Hide account, Full screen, and a Sign-in panel with the pool login, the live
2FA code (Copy, Type into browser), the password and the worker's facts. An
ERP-fleet worker (`worker-60-14-1`) only had a small view-only noVNC card on
its worker page since RS-416 (v1.365.0), with no sign-in panel and no way to
type a code or ask for a re-login, so clearing a 2FA prompt on a fleet worker
meant copying the code by hand into a viewer that took no input.

The fleet already had the pieces: the ERP's VNC relay
(`/api/fleet/vnc/:workerId/ws`, `apps/backend/src/fleet/vnc.ts`), the pool
snapshot with the account's secrets (the Pool tab's manager read), and a
worker (facebook-tracker 0.14.4 and later) that acts on a `relogin` heartbeat
directive once per appearance, while the backend always answered
`directives: []`.

## Acceptance criteria

- [x] `/fleet/watch/<fleet worker id>` shows the legacy layout: back link with the login, title, "<host> · <state> · heartbeat N ago", Watching/Not connected, Take control, Re-login, Hide account, Full screen, the live browser, the Sign-in panel and the footer note.
- [x] The Sign-in panel shows Pool #N, the live 2FA code (Copy, Type into browser only under Take control), login, password (reveal, type, copy), account UID, the Facebook user link, then State, Host, Session, Last heartbeat, Proxy (label, host:port, timezone) and Build, all from the fleet worker and its slot's pool account.
- [x] The viewer runs through the fleet relay; input reaches the worker only while Take control is on (noVNC view-only otherwise, as on the legacy page), and Type into browser uses the same keystroke path.
- [x] `POST /api/fleet/workers/:id/relogin` (manager) queues a one-shot `relogin` directive with an id; the next heartbeat delivers it once and later ones do not; a fresh claim drops one that never went out; a worker holding no slot is `409 not_running`.
- [x] Re-login on the fleet watch page shows the legacy confirm dialog and a strip (queued, taken, needs you).
- [x] The fleet worker page's Watch browser opens this page; homelab ids keep the legacy page.
- [x] The legacy page is rebuilt on the same shared pieces (`fleet/watchView.tsx`, `fleet/watchAccount.tsx`), not copied.

## Out of scope

- Re-login on the fleet worker detail page (only the watch page has it, as asked).
- A server-side input gate in the relay: the legacy bridge leaves view-only to noVNC too.
- The proxy's exit IP and location, and a region: the fleet does not look up or keep either.

## Notes

- Migration `0214_fleet_worker_relogin.sql` adds `relogin_id`, `relogin_requested_at`, `relogin_requested_by`, `relogin_delivered_at` to `fleet_workers`. CONTRACTS §5 and §7 carry the directive and the route.
- The worker accepts only string directives, so the wire stays `directives: ["relogin"]`; the id rides beside it as `relogin_id`.
