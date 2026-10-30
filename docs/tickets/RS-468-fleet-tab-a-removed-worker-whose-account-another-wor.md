---
id: RS-468
title: Fleet tab: a removed worker whose account another worker holds reads Replaced, not Parked
type: bug
status: backlog
priority: P3
created: 2026-10-30
reporter: jinhu
branch: ticket/fleet-replaced-worker-row
pr:
version:
related: []
---

## Ask

> How can i move this worker back to work?

(screenshot: the Fleet tab row `homelab-14 · homelab · No. 1 615…682 · Parked ·
beat 11 h 15 min ago · 0.15.0 (3576db7)`)

> yes

(in reply to: "I can file a ticket so the Fleet tab hides a silent worker once
another worker holds its account, or marks it something like 'Replaced by
homelab-3'. Want me to?")

## Context

On 2026-10-29 at 21:55 UTC the homelab agent removed `rs-fleet-homelab-14`
("beyond count 8") when the host's capacity was lowered, before v1.385.0
(RS-463) stopped agents removing workers. Its lease on account No. 1 lapsed
and `homelab-3` claimed the account; on 2026-10-30 at 09:13 UTC `homelab-3`
held No. 1 (epoch 6, HEALTHY), while `fleet_workers` still had
`homelab-14 → account_no 1`, its last heartbeat at 21:55 the day before.

The Fleet tab classes any silent worker as **Parked** (FEATURES.md, Fleet
bullet: "or it went silent"), so the leftover row looks like a stuck
account that needs rescuing. The owner asked how to move it back to work.
Nothing needed doing, because the account was already working. The row offers
no action. It is parked only because it went silent, so RS-452 withholds
**Retire & free**. If it ever had that button, pressing it would retire the
account the live worker is using. The row already hides its minutes when
another worker holds its account. The same check can decide its kind.

## Acceptance criteria

- [ ] A silent worker whose last account is now leased to a different worker
  is not counted or shown as Parked. It reads **Replaced by `<worker id>`**
  (grey), or is left out of the default Healthy and Parked views. Pick one in
  the plan.
- [ ] The Parked count in the toolbar legend and **Release parked (N)** do not
  count such rows.
- [ ] Such a row never offers **Retire & free** or **Mark healthy**, and the
  API refuses them for it with the existing `not_lost` path.
- [ ] A silent worker whose account nobody else holds still reads Parked, as
  today.

## Out of scope

- Deleting stale `fleet_workers` rows. The row is history, and the worker's
  page and the login ledger still reference it.
- Changing how agents number or start workers.

## Notes

Found while answering the question above. The read-only prod query was on
`fleet_slots` joined with `fb_pool_accounts`, plus `fleet_workers`. All 15
fleet accounts were leased (4 on homelab, 11 on worker-60-14). That is why
homelab ran 4 of capacity 10 (`workerCount` in
`apps/backend/src/fleet/hosts.ts`).
