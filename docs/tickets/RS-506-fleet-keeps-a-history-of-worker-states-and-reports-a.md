---
id: RS-506
title: Fleet keeps a history of worker states and reports account loss per browser engine
type: story
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/hafgufa
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1058
version: 1.408.0
related: []
---

## Ask

> Plan how to migrate current brower agent to the cloakbrowser. Evaluate the overall benefit

> Review current fb fleet infra and create an detailed implementation plan for the development and rolling out.

> go ahead and follow the implementation plan to start development.

## Context

The CloakBrowser plan (`~/.claude/plans/review-current-fb-fleet-cozy-bunny.md`,
Design §3) switches ERP-fleet accounts to a stealth Chromium one at a time.
Whether that pays off is a question of how often an account is lost to
SESSION_EXPIRED, CHECKPOINT or a CHALLENGE on each engine. `fleet_workers.state`
keeps only the latest value, so there was nothing to count. This is PR A of the
plan: it ships first and on its own, so the stock baseline accumulates before
any account is switched.

## Acceptance criteria

- [x] Migration `0221_fleet_worker_state_events.sql` adds
      `fleet_worker_state_events`, indexed on `(account_no, at)` and `(at)`.
- [x] A heartbeat that changes a worker's state writes one row in the same
      transaction, stamped with `fleet_slots.device->>'browser_engine'`
      (`stock` when absent). A repeated state writes none.
- [x] `GET /api/fleet/stats/engine-loss?days=30` (manager-only) answers, per
      engine, account-days, losses by state entered and losses per 100
      account-days, plus a `retro` block from `fb_worker_accounts` stints that
      ended `problem` or `retired`.
- [x] `tests/fleet-state-events.test.ts` covers the write, the no-op, the
      engine stamp and the arithmetic; the other `fleet-*` tests still pass.

## Out of scope

The engine switch route, `fleetDeviceFor`'s cloak fields, the UI card and the
worker side: other tasks of the same plan.

## Notes

- Account-days are stint time (`fb_worker_accounts`) on ERP-fleet workers,
  told apart from homelab stints by having state events for that worker, split
  by the engine of the account's latest event at each moment.
- A loss counts once: an entry into a lost state whose account's previous event
  was already lost (a reboot of a parked worker, CHECKPOINT then
  SESSION_EXPIRED) is not a second loss.
- A claim's reset of the state to NULL writes no row; the next heartbeat's row
  has `from_state` NULL.
- `retro` covers both fleets and is all stock, since nothing ran cloak before.
