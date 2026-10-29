---
id: RS-451
title: Retire a parked worker's account and free the worker
type: story
status: done
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/pelican
pr: 988
version: 1.379.0
related: [RS-436, RS-394]
---

## Ask

> build an feature to  release parked worker.  I meant retire the account and release to worker to free.

## Context

An ERP fleet worker whose Facebook account is lost (Session expired,
Checkpoint, Challenge, Dead) is Parked on the Fleet tab (RS-436). It keeps
heartbeating, holds its slot and a place on its host, and searches nothing.
Freeing it took two steps on two pages (Park on the Fleet tab, Retire on the
Account Pool page), and the dead slot row stayed in the fleet afterwards.

The pieces already exist. Retiring a pool row fires `fleet_fence_pool_owner`
(`migrations/0207_fleet_recovery.sql`), which moves the slot's epoch on,
clears its lease and puts the leased task back in the queue. The fenced
worker's next call gets `409 stale_epoch`; it closes its browser and exits 75
(`trackers/facebook/rs_worker/entry.py`), and the host agent starts a fresh
container a minute later that claims the next free slot (`fleet/claim.ts`).

## Acceptance criteria

- [x] `POST /api/fleet/slots/:no/retire` (manager only), in one transaction:
      the pool row turns `retired` with no holder and a `retired` pool event
      naming the fleet, the slot is deleted, its ready probe is cancelled and
      its leased task goes back to the queue. 404 for an unknown slot.
- [x] The worker that held it is refused on its next call and exits; its next
      container claims another free account, or gets `no_slot` when none is.
- [x] Fleet tab: a Parked ERP-fleet row with a slot shows **Retire & free**;
      healthy rows and coordinator (homelab) rows do not.
- [x] ERP worker page: the same action when the worker or its slot is parked.
- [x] The confirm dialog names the account and worker, and says the account is
      retired, the worker stops, and its host starts a fresh one that signs in
      to the next free account (a Facebook login).
- [x] English and Chinese strings.

## Out of scope

- A worker parked for an operator (DEAD `connect_failed`) exits 78 on a stale
  epoch and the host agent leaves it stopped until a person starts it. The
  dialog says so for that state; the agent is not changed.
- Homelab coordinator workers.
- Retiring a healthy account from the Fleet tab.

## Notes

No migration: the existing pool trigger does the fencing; the route only
retires the pool row and deletes the slot in the same transaction.
