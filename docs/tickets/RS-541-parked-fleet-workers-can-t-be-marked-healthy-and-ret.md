---
id: RS-541
title: Parked fleet workers can't be marked healthy, and retries ignore the proxy
type: bug
status: done
priority: P1
created: 2026-11-05
reporter: jinhu
branch: JinhuW/frogfish-4
pr: 1098
version: 1.424.1
related: []
---

## Ask

> https://inventory.recycleservers.com/#/fleet/watch/worker-60-14-5
> This worker does working, But is is parked.

> I already sent, But it didn't update to healthy.
> 2. Yes. fix it

## Context

`worker-60-14-5` (account #16) did no task after 2026-11-03 00:09 UTC. Its
browser and container were fine; two bugs kept it parked.

`resumeWaiting()` in `pages/desktop/fleet/shared.tsx` treated any delivered
resume as pending while the worker was `DEAD`. Once an auto-retry failed, Mark
healthy stayed on a disabled "Sent", beside text saying to use Mark healthy. Prod
logs show no `POST /resume`, and the last request in the DB was `auto` from
2026-11-04 00:46.

Auto-retries (RS-512, v1.411.0) ran on a timer alone. Decodo :10007 was failing
the ERP's checks, so all 8 tries were spent by 2026-11-04 00:46 UTC. Its last
failed check was at 10:45 that day, and nothing retried after it recovered.

## Acceptance criteria

- [x] After a delivered resume fails and the worker stays `DEAD`, Mark healthy can be clicked again; "Sent" lasts at most 2 minutes after delivery.
- [x] An undelivered resume still shows "Sent".
- [x] While the slot's proxy's latest fresh check is failing, no auto-retry is queued and no try is spent.
- [x] When that proxy passes again, the retry goes out at the next heartbeat if its time has come.
- [x] A worker with all tries spent, whose proxy failed a check after its last resume and now passes, gets a new resume and its count restarts at 1.
- [x] With no fresh check, or no proxy, the schedule works as it does today.
- [x] A proxy that passes while the worker keeps failing still stops after 8 tries.
- [x] The worker page says it is waiting for the proxy, not "sending at the next heartbeat", while the proxy is down.

## Out of scope

- Worker image changes or restarts: this is all ERP side, so no logins.
- Probing the proxy from the worker's host: ERP checks run from Railway, so a host-only fault still uses the timer and stops after 8 tries.
- `worker-60-14-3` (`Page crashed`) and `worker-60-14-13` (no slot): not investigated here.
