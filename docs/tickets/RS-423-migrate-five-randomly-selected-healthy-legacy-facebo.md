---
id: RS-423
title: Migrate five randomly selected healthy legacy Facebook workers
type: task
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: chore/five-worker-migration
pr: 948
version: facebook-tracker 0.14.13
related: [RS-394, RS-419, RS-421, RS-422]
---

## Ask

> start to migate another 5 more random worker

## Context

Continue the owner-approved full-session migration used by RS-419, RS-421
and RS-422, into the dev fleet. Random selection without replacement from
seven healthy legacy workers with matching active pool assignments chose
nyc-1 (#16), sc-1 (#12), homelab-1 (#9), ca-4b (#36), and nj-2b (#33).
Preserve each original proxy, browser device, full Playwright state and cache.

## Acceptance criteria

- [x] Verify every original proxy from both hosts without Facebook and validate
      the new runtime offline before stopping a source.
- [x] Transfer checksum-verified final sessions and complete monitor caches
      after clean source stops, one account at a time.
- [x] Start each target once, spaced apart; require a restored-session boot and
      HEALTHY, and stop/park on connection failures, challenges or failed restore.
- [x] Retire only successfully migrated legacy launch paths, update ownership,
      retain backups and record results. Keep existing fleet containers intact.
- [x] Provision target capacity and per-worker authentication for slots 5–9.

## Out of scope

west-1 activation or proxy changes, password logins, fleet-wide restarts,
production application deployment and enabling dev alerts.

## Notes

Same process expressly requested by the owner; no additional plan approval
is needed. Target runtime remains the tested 0.14.10 pinned image.

All ten non-Facebook proxy probes matched the original exits. Each of five
offline headed-browser tests restored its complete state with network none.
Shared edge env was preserved and its token map extended to worker-60-14-9;
a repeated idempotent claim verified the map without a browser boot or epoch
change. Host capacity was already 13 on the live preflight and is preserved.

All five restored one session boot each and reported HEALTHY. Complete results,
start times, login ledger ids and private backup references are recorded in
[WS-H-migration.md](../superpowers/plans/2026-10-24-erp-fleet/WS-H-migration.md).
Existing containers 1–4 and west-1 were unchanged.
