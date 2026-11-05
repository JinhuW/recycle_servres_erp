---
id: RS-537
title: Fleet: atomic account enrollment and browser profile
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/fleet-enrollment
pr: 1092
version: 1.421.0
related: []
---

## Ask

> Deep review the all feature of these https://cloakbrowser.dev/ and see how we can integrate with my current automation system and see how it can integrate with my proxy service.
>
> Long term goal, It will auto simulate the browser profile for each account.
>
> Create an detailed launch plan for it.

## Context

This implements workstream B of `docs/superpowers/plans/2026-11-04-cloakbrowser-launch-plan.md`.

`POST /api/fleet/slots` made a slot a worker could claim at once, and the engine
switch was a second call: a claim in between got the refusal `engine_live_session`.
`fleet_slots.device` goes with the slot, so a remove and re-add lost the seed and the
`cloak_seeded` guard. Limits counted `proxy_id`, while on 2026-11-04 14 of 20 ports
changed exit IP, so a port isn't an identity.

## Acceptance criteria

- [x] Profile (engine, seed, GPU, timezone) stored on `fb_pool_accounts`; re-add keeps it and the `cloak_seeded` guard.
- [x] `fleet_pilot_enrollments` outlives the slot and the account, and the first claim stamps `first_claimed_at`.
- [x] `POST /slots` takes `pilot`, `arm`, `engine` and writes everything in one transaction; a claim racing enrollment never sees a half-set slot.
- [x] Without the new fields, behaviour is as before.
- [x] Enrollment refuses an exit IP shared across ports, slots, active enrollments and homelab workers, and a stale (over 15 minutes) or failing measurement.
- [x] A plain add or Change proxy on an account that isn't enrolled is refused (`exit_shared`) when its target's last measured IP is held by another account's active pilot enrollment; with no pilot or no measurement, nothing changes.
- [x] A unique index holds seeds apart; a duplicate is refused.
- [x] Proxy edits don't rewrite a pinned profile's timezone.
- [x] Cloak claim answers add `expected_exit_ip` and `webrtc_ip`, null without a fresh measurement, never a refusal.
- [x] `cloak_max_slots` holds on enrollment, counting parked slots.
- [x] With `cloak_enabled=false` an existing cloak account still claims and gets the licence through the real edge code; only new enrollment stops.
- [x] `CONTRACTS.md` covers claim fields, enrollment and stop semantics.

## Out of scope

Automatic arm assignment for a batch and the automatic profile (Phase 3): the caller
passes the arm. Reading the zone from the exit: workstream A adds that column, so
enrollment pins the proxy's typed timezone until then.

## Notes

- `FLEET_EXIT_FRESH_MS` is 15 minutes, three 5-minute rounds: one missed round and one late one don't stop enrollment, and a stopped probe does.
- `fleetCloakFor` still hashes the account number into 90,000 seeds, so a collision is refused (`cloak_seed_taken`) rather than re-rolled, and the operator picks another account.
- `deploy/railway-sync/restore-fleet.sql` keeps the profile columns on dev and clears a colliding seed on the copy, agreed with the coordinator because the unique index could otherwise fail the nightly restore.
- The migration backfills only slots that already hold a seed, so stock slots stay unpinned.
