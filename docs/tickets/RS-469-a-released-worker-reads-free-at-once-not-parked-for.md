---
id: RS-469
title: A released worker reads Free at once, not Parked for 15 minutes
type: bug
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: fix/released-worker-free
pr: 1011
version: 1.387.2
related: [RS-461, RS-468]
---

## Ask

> I hope once i click the button to release the parked worker. It should go back to free statys

(screenshot: the Fleet tab filtered to **Parked 3**, showing worker-60-14-9 /
-11 / -12 on accounts No. 56, 75, 69, all Session expired, "beat just now")

## Context

**Release parked (N)** (RS-461, v1.383.0) retires each account and deletes its
fleet slot. The worker's next call is refused with `409 stale_epoch`
(`apps/backend/src/fleet/auth.ts`), and it exits. On 2026-10-30
`rs-fleet-worker-60-14-9` showed `Exited (75)` a minute after the release.
The row still read Parked. In `erpRow`
(`apps/frontend/src/pages/desktop/fleet/fleetRows.ts`) a row was Free only
when it was not `running`, and `liveness()` counts a beat as live or stale for
15 minutes. So every released worker sat under Parked for up to 15 minutes.

A worker without a slot has nothing to do. Its next call is refused, so it is
Free as soon as the slot is gone.

## Acceptance criteria

- [x] A worker whose account has no fleet slot reads **Free** whether or not
  it reported in the last 15 minutes, as long as its host still exists.
- [x] The legend's Free and Parked counts and **Release parked (N)** follow on
  the next refresh after the release.
- [x] A worker of a deleted host still reads Parked. A silent worker whose
  account another worker holds still reads Parked (RS-468).
- [x] The running count is unchanged: a worker still reporting counts as
  running until it stops.

## Out of scope

- RS-468's "Replaced by" row.
- Changing the liveness windows.
