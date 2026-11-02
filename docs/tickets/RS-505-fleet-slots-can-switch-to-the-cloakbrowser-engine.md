---
id: RS-505
title: Fleet slots can switch to the CloakBrowser engine
type: story
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/chiton
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1059
version: 1.409.0
related: [RS-504]
---

## Ask

> Plan how to migrate current brower agent to the cloakbrowser. Evaluate the overall benefit

> Review current fb fleet infra and create an detailed implementation plan for the development and rolling out.

> go ahead and follow the implementation plan to start development.

## Context

The CloakBrowser plan (`~/.claude/plans/review-current-fb-fleet-cozy-bunny.md`,
Design §1, §2 and §4) moves ERP-fleet accounts to a stealth Chromium one at a
time. Each account is one machine to Facebook. A new fingerprint shown to a
logged-in account is the location and device churn that gets accounts
checkpointed, so the switch has to wait until an account has no live session.
This is PR C of the plan. It needs PR A (RS-504, `fleet_worker_state_events`),
because going back to stock depends on whether the cloak session ever reached
HEALTHY. The worker side that reads the device keys is PR B, in the tracker.

## Acceptance criteria

- [x] `fleet_slots.device` may carry `browser_engine` (`stock`/`cloak`),
      `cloak_seed` (10000–99999) and `cloak_gpu` (`NVIDIA`/`Intel`).
      `fleetCloakFor(no)` derives the seed and GPU from the account number, so
      the same account always gets the same values. The claim hands the keys
      to the worker.
- [x] `POST /api/fleet/slots/:no/engine` (manager-only) switches to cloak only
      for a slot with no worker, a parked one, or one whose worker reports
      SESSION_EXPIRED, CHECKPOINT or CHALLENGE_*. It also needs
      `cloak_enabled` on, fewer than `cloak_max_slots` cloak slots and no seed
      written before. Refusals are 409 `engine_live_session`,
      `cloak_disabled`, `cloak_slots_full` or `cloak_seeded`. Going back to
      stock is refused with `cloak_proven` once the cloak session was HEALTHY.
- [x] Fleet settings `cloak_enabled` (default false) and `cloak_max_slots`
      (default 1, 0–100) are read and saved through `/api/fleet/settings`.
- [x] The Fleet tab's table has an Engine column (Stock, or CloakBrowser with
      seed and GPU). It offers "Switch to CloakBrowser" only where the guard
      would allow it. The confirm dialog says the move is one way and that
      Facebook sees the new device on the account's next normal start. Each
      refusal reads as a sentence.
- [x] A CloakBrowser row offers "Back to stock" behind a confirmation that
      says it is another new device. The route decides whether the cloak
      session was ever healthy (409 `cloak_proven`).
- [x] A Browser engine card beside the hosts has the CloakBrowser on/off
      switch, the seats stepper and the losses per 100 account-days for
      stock, CloakBrowser and the stint baseline over 30 days.
- [x] The ERP worker page shows the engine, seed and GPU under the browser.

## Out of scope

- The worker's `browser_engine.py`, the image and the probe (PR B, tracker).
- Any restart, re-login or release. The new engine is picked up at a worker's
  next normal start.

## Notes

- Going back to stock keeps `cloak_seed` and `cloak_gpu` on the device. That
  fingerprint is what the account has shown, so the slot is never switched
  to cloak again (`cloak_seeded`).
- `cloak_max_slots` counts every slot whose device says cloak, parked ones
  included, because a parked slot runs again once unparked.
- The row's guard is `fleetCloakSwitchable` in `packages/shared`, the same one
  the route uses, read from the page's last poll. A switch made stale by a
  newer heartbeat still gets the route's 409.
