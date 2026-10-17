---
id: RS-276
title: Worker page assigns a pool account instead of typed credentials
type: story
status: in-progress
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-dynamic-cities
pr:
version:
related: [RS-254, RS-268, RS-275]
---

## Ask

> 2. The edit credentials. It shoulds comes form the account pool. instead of edit on our own. it can select unused accounts.

## Context

The worker page's **Edit credentials** dialog (`EditCredentialsModal`,
`apps/frontend/src/pages/desktop/FleetAccounts.tsx`, RS-254) had the manager
type a login, password and 2FA key into the coordinator vault by hand, while
the accounts we buy sit in the ERP's pool (`fb_pool_accounts`). RS-275
(v1.272.0) added `POST /api/facebook-pool/:no/assign`, which writes a pool
account's login into a worker's vault and queues Re-login, but only from the
pool page's account editor, and it refuses a worker that already holds a pool
account (`fpWorkerTaken`) — so swapping a broken account meant two trips.

## Acceptance criteria

- [ ] The worker page's dialog (now **Assign account**) lists only available pool accounts that have a password, searchable by #, UID, e-mail or batch; no free-typed login or password remains.
- [ ] Assigning goes through `/assign`: vault written, Re-login queued, the account marked Fleet for that worker.
- [ ] If the worker already holds a pool account, the dialog requires a choice — Available, Problem or Retired — and `/assign` moves that account there in the same transaction that marks the new one; a Problem account keeps the worker as holder.
- [ ] Without `previous`, `/assign` still refuses a worker that holds another account (`fpWorkerTaken`), so the pool page's flow is unchanged.
- [ ] Backend test covers the swap to Problem and to Available and a bad `previous`.

## Out of scope

- The pool page's own editor flow (RS-275) — unchanged.
- The backend `PUT /api/coordinator/accounts/:id` proxy stays; the ERP UI no longer calls it.

## Notes

- Decided with the requester: the previously held account's fate is asked
  each time, no default.
- Same request also asked for dynamic, tiered city search; that is a separate
  ticket. RS-275 shipped per-worker city editing in the meantime.
- A first cut added its own `/install` route and collided with RS-275 landing
  on `dev` mid-session (same migration number); it was rebuilt on `/assign`.
