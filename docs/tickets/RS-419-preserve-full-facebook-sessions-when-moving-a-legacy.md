---
id: RS-419
title: Preserve full Facebook sessions when moving a legacy worker to the ERP fleet
type: bug
status: in-progress
priority: P1
created: 2026-10-27
reporter: jinhu
branch: fix/ca3-full-session-handover
pr:
version:
related: [RS-394, RS-291]
---

## Ask

> i would like to use the ca-3 to try the migration.
>   from the lgecay to the new apporach to use the worker.
>   try your best to avoid facebook block it

> i think you should copy all session data to the new fleet one

> go ahead and fix it. then migrate

## Context

The current fleet claim reconstructs a Playwright state with cookies and empty
origins; session uploads also store cookies only. The healthy legacy ca-3 has
local storage and IndexedDB in its saved state. Dropping those changes the
browser state during the move. Its current account is #55, not the earlier
locked #22 used in the abandoned pilot. The original saved state, sidecar and
identity were staged privately on worker-60-14 before any stop.

## Acceptance criteria

- [x] Claims, worker rendering and session uploads preserve complete Playwright
      cookies, local storage and IndexedDB, including partitioned cookies.
- [x] Cookie-only clients remain compatible and cannot erase stored origins.
- [x] Invalid or foreign-account uploads are refused without replacing state.
- [x] Regression tests cover upload → sealed storage → claim → rendered state.
- [ ] Only ca-3 is migrated, using a fresh snapshot after its clean stop and
      the same proxy, Chromium build and presented device settings.
- [ ] Verify one restored-session boot and a healthy fleet heartbeat; stop on
      any checkpoint or challenge without automatic login retries.

## Out of scope

Other legacy workers, a fleet-wide release/restart, a new Facebook login,
checkpoint recovery and synthetic stale-epoch restart tests on the live account.

## Notes

Approved in the conversation on 2026-10-27. The additive protocol uses optional
`account.storage_state` on claims and `storage_state` on session uploads. The
existing encrypted pool cookie column holds the complete state; no schema
change is needed. Old uploads retain origins under the same account lock.
See `docs/superpowers/plans/2026-10-24-erp-fleet/WS-H-migration.md`.
