---
id: RS-458
title: Fleet: label a worker its host removed as Removed, not Parked
type: bug
status: done
priority: P2
created: 2026-10-29
reporter: jinhu
branch: JinhuW/frogfish-2
pr: 1000
version: 1.381.0
related: []
---

## Ask

> why this get parked?
>
> [screenshot: homelab-14 · homelab · No. 1 · Parked · beat 4 h 42 min ago · 97/360 min · 0.15.0 (3576db7)]

Replying to "The page could show 'Removed by host' for this case instead of Parked.
I can make that change if you want it.":

> Yes. How can i move it back?

## Context

homelab-14 had not failed. At 21:55 UTC on 2026-10-29 homelab's capacity was
lowered from 14 to 8 and then to 5. The fleet agent removed homelab-6 through
homelab-14 (`remove … reason: "beyond count 8"`). Account No. 1's lease
lapsed, and homelab-3 claimed it and stayed HEALTHY. "Moving it back" needed
nothing.

The Workers table's `erpRow` (`apps/frontend/src/pages/desktop/fleet/fleetRows.ts`)
labels every worker that has gone silent `parked`. So the leftover row for a
container that no longer exists showed as a red Parked. Its row also showed
slot No. 1's minutes (97/360), which were homelab-3's: when the slot names
another worker, the slot lookup falls back to the account's slot.

The host agent already reports its containers in `FleetHost.report.containers`,
and the tab already loads hosts. That is enough to tell a removed worker from
a parked one, with no backend change.

## Acceptance criteria

- [x] An ERP worker that isn't reporting, whose host's latest report lists no
      container for it, has row kind `removed`. Its chip reads "Removed by
      host" in neutral grey, not red.
- [x] The Workers legend has a third bucket, **Removed**, with its own count.
      Removed rows no longer count in **Parked**.
- [x] A silent worker whose container still exists (exited, or held for an
      operator) stays **Parked**.
- [x] A row whose account slot another worker now holds shows no minutes or
      budget.
- [x] Coordinator rows are unchanged.

## Out of scope

- Hiding or deleting removed worker rows. They still drop off after 7 days.
- Any backend change.

## Notes

- The signal is the host agent's own report (`FleetHost.report.containers`).
  It lists stopped containers too, so absence means removed, not just exited.
  A worker on a host with no report stays Parked.
- Verified locally with a seeded host: running → Healthy, exited container →
  Session expired (Parked), missing container → Removed by host. On prod at
  the time, homelab-11 to -14 are the rows this relabels.
