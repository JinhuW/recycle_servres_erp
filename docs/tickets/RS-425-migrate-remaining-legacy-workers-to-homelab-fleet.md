---
id: RS-425
title: Migrate the remaining legacy workers into the new homelab Facebook fleet
type: task
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: chore/homelab-worker-migration
pr: 951
version: facebook-tracker 0.14.14
related: [RS-419, RS-421, RS-423]
---

## Ask

> I just set another Coordinator in the homelab host. try to migrate worker to the new Facebook fleet

> I just set another Coordinator in the homelab host. try to migrate the remaining legacy worker to the new Facebook fleet

## Context

The owner installed the ERP fleet agent on the existing homelab machine,
registered as host homelab on dev. On preflight it was observe-only at capacity 0 and had not started a browser. The owner expanded the request to all seven remaining legacy workers.
Continue the approved full-session process, beginning with nj-3b (#47).
Five accounts are still Fleet; phl-1 (#4) is Retired and ca-2b (#52) is
Problem, so those two retain their pool status and migrate parked without
a Facebook boot. All accounts stay on the same host and original proxies.
New active workers use homelab-1 onward and loopback VNC ports 5991 onward,
avoiding legacy VNC ports. Hosts stay observe-only while new slots are staged.
The target id overlaps a retired legacy worker; detach only that retired
name's old vault binding, retaining its account data and historical records.

## Acceptance criteria

- [x] Verify original proxy, full state, cache and presented device; validate
      restoration offline with network disabled before stopping the source.
- [x] Provision per-worker coordinator authentication and retain shared secrets.
      Reusing the retired worker name cannot expose its old vault credentials.
- [x] Stop each source cleanly and transfer checksum-verified final state and
      monitor cache; start eligible targets once, spaced at least three minutes
      apart, with no password/token fallback; require HEALTHY and one restored
      boot. Retired/Problem accounts and failed proxies stay parked with no boot.
- [x] Retire transferred legacy launch paths, preserve backups and history,
      update active ownership and enable normal management for the new host.
- [x] Preserve existing Facebook browsers and the coordinator/console, keep
      parked accounts parked, and leave dev alerts off.

## Out of scope

Re-login or restart of SESSION_EXPIRED workers, west-1 activation or IP
changes, reactivating Retired/Problem accounts, production deployment and
fleet-wide rolls.

## Notes

The prior batch's denver-1 and nj-2b now report logged out between sweeps;
these are existing states, not caused by this migration. They are left alone.
Runtime remains pinned 0.14.10. Its already-expired #64 later became parked
and self-exited 75; the exact stopped container received an operator hold.
Only the peer host agent was stopped/started to load that hold, preserving
all Facebook worker container ids and start times.

Preflight found mw-1 (#14)'s original :10003 proxy returns HTTP 503; it
will transfer parked with no browser boot or IP change. The other four
active accounts map to homelab-1 through -4, VNC 5991–5994. All seven full
states passed headed offline restoration with network disabled. Both host
agents are observe-only during handovers; running containers keep operating.

The first canary exposed a real routing gap: the existing socat relay accepts
only 10.10.60.14 and rejects local Docker hairpin traffic from 172.24.0.1.
Replace only that relay with a pinned HAProxy container allowing those two
sources. The coordinator and worker browsers remain running. The canary
restored and reported HEALTHY, but its first coordinator ledger write was
unreachable; retain the container log as evidence and document the gap, with
no second boot or fabricated ledger record.

Completed: four HEALTHY transfers and three parked full-state/cache transfers;
all legacy launches retired. Relay correction, initial canary audit gap,
timings, cache counts and backups are recorded in
[WS-H-migration.md](../superpowers/plans/2026-10-24-erp-fleet/WS-H-migration.md).
