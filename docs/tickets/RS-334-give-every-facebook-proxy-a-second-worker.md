---
id: RS-334
title: Give every Facebook proxy a second worker
type: task
status: in-progress
priority: P2
created: 2026-10-20
reporter: jinhu
branch: fb-pair-every-proxy
pr:
version:
related: [RS-332, RS-333, RS-331]
---

## Ask

> let we create two worker for each proxy for now.

## Context

RS-332 put a second worker on two Palo Alto IPs (10014, 10015) as a pilot,
with ca-3 and ca-4 single as the control and a 14-day wait before widening.
The requester chose to pair every IP now. The other 18 of the 20 Decodo
ports each get a partner worker, for 40 workers in all.

A new worker searches nothing until it has an account, so creating the
partners risks nothing by itself. The risk comes with assignment. Nine of
these IPs carry live accounts (homelab-1, ne-1, mw-1, west-1, sc-1,
denver-1, nyc-1, phl-1, va-2), and a checkpoint on a new partner can pull
its live neighbour in. The rules in `deploy/README.md` → *Scaling notes*
apply to every pair: different cities, different sweep times, and first
logins a day or more apart.

Capacity on the VM (8 cores, 62 GB) on 2026-10-20, with 22 workers: 37 GB
available, a parked worker at about 0.5 GB and a working one at 0.8–2 GB.
Partners sweep at 17:00 UTC and the fleet at 13:00, so each sweep window runs
20 browsers, twice today's 10.

## Acceptance criteria

- [ ] Each of the 18 single-worker IPs gets a partner `<id>b` (homelab-1b,
      ne-1b, mw-1b, west-1b, sc-1b, denver-1b, nyc-1b, phl-1b, wc-1b,
      va-2b, bos-1b, nyc-2b, nyc-3b, ca-3b, ca-4b, nj-1b, nj-2b, nj-3b) on
      its IP-mate's proxy var, with its own token, session dir, cache volume
      and VNC port (5924–5941).
- [ ] Each partner seeds a catalog city near its exit that its IP-mate does
      not search.
- [ ] Each partner sweeps at 17:00 UTC (`settings start-at`), while its
      IP-mate keeps the fleet's 13:00.
- [ ] The partners on West Coast exits (ca-3b, ca-4b, denver-1b, whose exit
      is Seattle) have vault slots in region `rs_west`, for Pacific-time
      devices.
- [ ] The console lists all 18, so the Fleet tab shows every IP with two
      workers.
- [ ] No existing worker container is recreated.

## Out of scope

- Assigning accounts. That is the requester's step, in the order in the
  notes.
- A third worker per IP.
- Moving the fleet under `rs-fleetd`. At 40 compose files it is overdue,
  but it restarts every worker once.

## Notes

Assignment order, so no IP sees two first logins in one day:

1. The nine IPs with no live account first: give one worker on each its
   account (wc-1, bos-1, nyc-2, nyc-3, ca-3, ca-4, nj-1, nj-2, nj-3), and
   the pilot's ca-1 and ca-2.
2. A day later, their partners.
3. The partners of the nine live accounts last, one or two a day, starting
   with the accounts that matter least. If a partner is checkpointed, stop
   it before its live neighbour is affected.
