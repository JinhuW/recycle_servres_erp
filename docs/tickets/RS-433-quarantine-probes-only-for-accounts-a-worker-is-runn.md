---
id: RS-433
title: Quarantine probes only for accounts a worker is running
type: bug
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/stranded-probes
pr:
version: 1.371.2
related: []
---

## Ask

> why it is waiting, but i still have a few available workers?

> But no cities are tied to a worker right?

> no woker assigned.

> yes.

(Asked about the Fleet Queue tab, where four `quarantine probe` rows for
Ashburn and Boston sat "Waiting" for 3–16 hours. "yes." approved the fix
proposed below.)

## Context

Cities are not tied to workers; any worker takes any search. A probe is
different: `scheduler.ts` writes it with the quarantined account's
`account_no`, and `claim.ts` hands a probe only to that account's worker. An
account gets a worker only when a worker container boots and claims a free
slot, which is a Facebook login. The scheduler wrote probes for every
quarantined slot whether or not a worker held it, and only leased tasks ever
expire, so a probe for an account no worker ran stayed `ready` for good and
also blocked the next probe for that account. In the Queue it read "due,
waiting for a worker", like a capacity problem.

## Acceptance criteria

- [x] The scheduler writes a probe only for a quarantined slot with a live,
      non-parked lease.
- [x] A ready probe whose account has no live, non-parked lease is cancelled on
      the next reconcile.
- [x] A cancelled probe does not count toward `quarantine_probe_hours`, so a
      reclaimed account gets a probe on the next pass.
- [x] `tests/fleet-scheduler.test.ts` covers the three cases.

## Out of scope

- Booting a worker for a quarantined account so its probe can run: that is a
  login, and the fleet's first rule is not to cause one.
- A separate "account offline" state in the Queue UI: cancelling makes the
  rows leave the due list, which is enough.

## Notes

Prod picks this up on the release to `main`; the four stranded probes are
cancelled by the first reconcile after the deploy. No worker restarts.
