---
id: RS-543
title: Fleet: exit, lease and pilot rules for cloak slots
type: bug
status: done
priority: P1
created: 2026-11-05
reporter: jinhu
branch: JinhuW/cloak-fixes-wave-1
pr: 1100
version: 1.424.3
related: []
---

## Ask

> the dev change about the new cloakbrowser integration and some other minior change.
>
> Identify all issue and make sure these will not break any existing service.

> pls create an comprensive fix plan for these issue.

> 1. Yes. Probe hourly/
> 2. allow it.
> 3. Manager click start

## Context

Wave 1 of the CloakBrowser fix plan: the ERP's rules for exits, leases and
pilots. Review findings 2, 4, 6, 11, 12 and 14, plus nine exit and identity items.
RS-542 was wave 0. The worker's side (`facebook_opened`, `exit_moved`) comes with
worker 0.17.0, which no host runs yet.

## Acceptance criteria

- [x] A cloak claim sends the last exit seen, never null while a reading exists; a cloak slot with no reading isn't claimable.
- [x] A licence-outage heartbeat keeps the lease for 24 hours, and a manager can still park and remove the slot.
- [x] A release skips a worker parked on `license_outage` or `exit_moved`, skips running cloak workers during an outage, and still fails on `profile_preflight`.
- [x] The first-login hold ends at `first_login_at`, covers a handoff, a zone move on one IP and a remap onto another slot's exit.
- [x] `workerCount` doesn't count a slot a claim would refuse.
- [x] A cloak-arm account rescued on stock reads as failed and is flagged `crossed_arm`.
- [x] Re-recording an exit re-pins a clock the enrollment set; a Switch to CloakBrowser pins the measured zone.
- [x] A pilot's exit stops being reserved after its first login once it has moved on.
- [x] A taken seed is drawn again; a pool edit can't change the UID under a profile or a pilot record.
- [x] A URL edit records the exit change at the next reading; an overlapping round and Check now record one move once.
- [x] `keep-fleet.sql` keeps the pool row of an enrolled account with no slot.

## Out of scope

- A check run inside the URL edit request: claims wait for the next round, at most 5 minutes, which is just as safe. Wave 4 can run Check now from the dialog.
- `keep-fleet.sql` keeping stints: `SYNC_KEEP_FLEET` is 0 today, and losing them only touches dev's cohort history.
- Replacing a seed flagged by spike S2: only a collision draws again, since no quarantine list exists yet.

## Notes

Owner decision on Back to stock: allow it and count the account as failed, so the
route stays open and the cohort does the work.

A cloak slot on an unlisted proxy has no checks to wait for, so it still claims
with null IPs. Add to fleet always takes a listed proxy, so only old slots can
be in that state.

Testing caught a NULL trap here: `s.device->>'browser_engine' = 'cloak'` is NULL
for a stock slot, and `NOT` of it excluded every stock slot from claims.
