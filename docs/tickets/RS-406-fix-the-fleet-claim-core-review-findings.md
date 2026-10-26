---
id: RS-406
title: Fix the fleet claim-core review findings
type: task
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet/fix-claim-core
pr: "#916"
version: 1.353.0
related: []
---

## Ask

> Owner's go-ahead: fix every finding in your review (high, medium and low, plus the CONTRACTS §4/§5/§6 docs drift).

(Relayed by the coordinating session; the review covered the fleet claim and
ownership core: `apps/backend/src/fleet/{claim,auth,workers,sql}.ts`,
migrations 0206/0207, `/stopped`, `csrf.ts`, `packages/shared/src/fleet.ts`.)

## Context

A read-only review of the RS-394/RS-400 claim core found one high, five
medium and five low defects on `origin/dev`. The worst: server-side key
problems answered 401, which a worker treats as a dead token and exits on,
and every restart is a Facebook login. Parent: RS-394.

## Acceptance criteria

- [x] A missing `FLEET_WORKER_TOKEN_KEY`/`FB_POOL_KEY` answers `503 {error: "unavailable"}`; token 401s carry `missing_token`/`bad_token`/`expired_token`; `FLEET_WORKER_TOKEN_KEY_PREVIOUS` verifies and the heartbeat re-signs.
- [x] `claim` refuses a `worker_id` that is not `<host_id>-<n>`.
- [x] `next-task` re-hands a lease the epoch still holds; never two leases per epoch.
- [x] Handoff reservations carry `reserved_until` (20 min), show as reserved not parked; park/unpark clear the handoff.
- [x] `pickTask` does not lock the release row; familiar-city index added.
- [x] A slug verdict only from `finished` + boolean `matches` + no `detail.error`.
- [x] Replacement on a later epoch is not drained; claim retry/handoff wait for their own slot; hold arms before the first look and re-holds; lease checks use the DB clock.
- [x] `PUT /session` needs this account's `c_user` and `xs` unless `clear: true`; absent `token` keeps, `null` clears.
- [x] CONTRACTS §2–§6 match what ships.

## Out of scope

- Taking the host token out of worker containers (per-container claim tickets): it needs the agent and worker to change together. This PR binds `worker_id` to its host, which closes the cross-host impersonation; a compromised container can still claim free slots on its own host.
- A retry delay for slug checks that keep failing: the scheduler creates the next check (scheduler owner).

## Notes

Review findings and fixes are in the PR description.
