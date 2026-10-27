---
id: RS-422
title: Migrate denver-1 with its complete saved session and original proxy
type: task
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: chore/random-worker-migration
pr:
version: facebook-tracker 0.14.12
related: [RS-394, RS-419, RS-421]
---

## Ask

> start to migate another random worker

## Context

Continue the approved full-session handover used for ca-3 and wc-1b.
Random selection chose denver-1 from eight healthy legacy workers with known
proxy exits not shared by another active legacy worker and matching active
production-pool assignments. Its original proxy
is Decodo :10006; keep its account, browser settings, full Playwright state
and listing cache. west-1 stays parked on its failing original proxy.

## Acceptance criteria

- [x] Verify the original proxy from both hosts without Facebook before stopping.
- [x] Recheck source health and account identity, stop cleanly, and verify the
      complete saved state and cache after transferring them privately.
- [x] Copy the cache before one controlled new-container start; preserve the
      original proxy and device; omit password-login fallback.
- [x] Verify one restored-session boot and HEALTHY; stop on a failed restore,
      challenge or connection failure without automatic browser retries.
- [x] Retire the legacy launch paths, preserve backups, update account ownership
      and document the handover. Other workers keep their containers.

## Out of scope

Other workers, west-1 activation or IP changes, fleet-wide release/restarts,
password logins and enabling dev alerts.

## Notes

This uses the same owner-approved procedure as RS-419 / RS-421. The target
is the existing dev fleet; no production application release is required.

The initial health-only candidate was excluded because its pool account was
Retired. No source container was stopped for that candidate. Eligibility
requires a matching active assignment; this task does not revive retired
accounts.

The source stopped cleanly at 09:58:50 UTC. The final state, sidecar and
complete monitor home were checksum-verified, including a healthy SQLite
cache with 28,524 entries. worker-60-14-4 started at 09:59:37 on 0.14.10,
claimed #10 epoch 1, and reported HEALTHY at 10:00:01. Login #563 is its
single boot, outcome restored; the worker skipped password login. The
original proxy and pinned Mac Chrome/151 header remain unchanged, with all
21 IndexedDB databases present. The host is authoritative again at its
unchanged capacity of 4. Other running containers and west-1's parked slot
were unchanged. Detailed backups and rollback notes are in WS-H-migration.md.
