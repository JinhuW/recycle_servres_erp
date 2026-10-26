---
id: RS-412
title: Fleet tab table tracks workers only
type: story
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet-workers-only
pr:
version: 1.361.0
related: []
---

## Ask

> Why it is tracking the account instead of worker?

> It does not make sense to me, as we have a account pool page as well.
>
> I hope this table can only tracking the workers.

## Context

Since v1.344.0 (WS-E2 design) the Fleet tab's table is one row per pool
account: `fleetRows()` in `apps/frontend/src/pages/desktop/fleet/fleetRows.ts`
merges ERP slots, the coordinator's workers and a `pool:` row for every account
nothing runs. In prod that was 61 rows, 49 of them parked accounts with no
worker. The Account pool tab already lists every account with a Runs on
column, so the Fleet table duplicated it. Park, Unpark and Release quarantine
lived only on the idle rows; the pool's Runs on cell linked to `/fleet` for
them.

## Acceptance criteria

- [x] The Fleet table has one row per worker: the ERP's workers and, until
      cutover, the coordinator's (host `homelab`). An account no worker holds
      has no row.
- [x] A worker that stopped reporting stays in the table as **Offline**, with
      its last heartbeat.
- [x] Columns, in order: Worker (id, VNC port), Host, Account (no, masked
      uid), State, Now, Today, Lease, Version, eye.
- [x] Legend: All, Healthy, Degraded, Replacing, Parked (the worker reports
      Session expired / Checkpoint), Offline. Quarantined, In manual use and
      the host select's "Not running" are gone.
- [x] Copy speaks of workers: lede, foot ("N of M workers · K running on H
      hosts"), empty and no-match text.
- [x] Park stays on a running worker's row.
- [x] Unpark and Release quarantine move to the Account pool's Runs on cell,
      with the same confirm dialogs, in place of the links to `/fleet`.
- [x] The Fleet tab's badge still counts running workers.

## Out of scope

Backend or API changes (the data is already served); the pool table's other
columns; the host strip.

## Notes

Plan approved in session 2026-10-26.

`fleet_workers` rows are never deleted, so an offline ERP worker is kept only
for a week after its last heartbeat; older ones are retired containers. A
worker's running state now comes from its heartbeat alone, not its lease: one
between leases still reports. Verified locally with mocked `/api/fleet/*`
(the backend routes are unchanged): worker-only rows, the Offline row, and
Unpark / Release from the Account pool firing their POSTs.
