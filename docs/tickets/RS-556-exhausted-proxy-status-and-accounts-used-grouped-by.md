---
id: RS-556
title: Exhausted proxy status, and Accounts used grouped by IP
type: story
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/lungfish
pr: 1124
version: 1.432.0
related: []
---

## Ask

> The account used should link to the IP instead of the worker.

> I hope it can group by the ip. also note the ip status.(deprecated, active)

> I am about about the ip instead of proxy

> Add a new exhaust status for the proxy. When a IP for a proxy has been used for 5 time (failed), Then the proxy will use the exhaust status and not available to use. It will wait for the manager to rotate the IP in the decodo.

## Context

An ERP fleet worker is whichever container claimed a slot, so its Accounts used
card (`fleet/workerDetail.tsx`, RS-365) could show 9 accounts on 9 ports, which
says nothing about any one IP. Facebook sees the IP.

DEAD, the nearest status, had three gaps. Only the homelab `/assign` refused it:
Add to fleet, Change proxy (RS-521) and claims ignored it, so `Decodo :10001` read
DEAD with an account on it. It followed the port, so failures kept counting after
the IP moved (RS-538 records those moves), and only Revive cleared it. And
`fb_worker_accounts` stored the port alone, so no stint could be tied to an IP.

## Acceptance criteria

- [x] A port's 5th failed account on its current IP makes it Exhausted on the Proxies tab and on the worker's page.
- [x] Add to fleet, Change proxy and `/assign` refuse an Exhausted proxy, and the pickers show it disabled.
- [x] A worker can't claim a slot on an Exhausted proxy. An account already running there keeps running.
- [x] When a check sees a new IP on the port, the port is Active again with its count at 0, and the old IP reads Deprecated.
- [x] Accounts used on a worker's page is grouped by IP, with a status on each group and every account on that IP from any worker.
- [x] Stints the checks don't cover appear under "IP not recorded".
- [x] The worker's History still shows only that worker's own stints.

## Out of scope

- Calling the Decodo API to rotate an IP.
- Stopping accounts already running on an Exhausted proxy.
- Merging failures when two ports share one IP.
- Slots with no listed proxy (`proxy_id` NULL): the claim can't identify them as Exhausted, because their URL is sealed.
- A Revive button for ERP ports.

## Notes

- Exhausted replaces DEAD with the same threshold, more than 4 failed accounts.
- A failed stint counts against the IP stamped on it. One with no stamp counts
  against the port's current IP when it ended after the port's last IP change.
- An open stint follows its port's IP each check, so one stint carries one IP: the
  one it was last on.
