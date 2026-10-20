---
id: RS-333
title: "Fleet tab in three layers: location, proxy IP, workers"
type: story
status: in-progress
priority: P2
created: 2026-10-20
reporter: jinhu
branch: fleet-three-layers
pr:
version:
related: [RS-332]
---

## Ask

> 3 layers. Location -> proxy ip -> wokers

## Context

v1.303.0 (RS-332) grouped the Fleet tab's workers table by exit city. The
proxy showed only as a port in each worker's subtitle, plus "shares IP with
…" on the two-per-IP pilot pairs. With accounts now sharing IPs, the proxy is
the unit between the city and the account: it is what Facebook sees, and
what a checkpoint on one account puts at risk for the others. So it gets a
row of its own.

## Acceptance criteria

- [ ] Under each location divider, each proxy has a row: its port, exit IP
      and worker count. The exit's ISP is in the tooltip.
- [ ] Each proxy's workers sit under it. A proxy with more than one worker is
      marked shared, and its tooltip says to keep their cities and sweep
      times apart.
- [ ] Workers on the VM's own IP sit under one row of their own, and workers
      whose exit is still being looked up keep their proxy rows under the
      pending location.
- [ ] With no column sort, proxies run by port and each proxy's workers by
      id. A column sort orders proxies by their highest-ranked worker and
      workers within each proxy, with locations kept as they are.
- [ ] The worker subtitle no longer repeats the port or the shared-IP note.

## Out of scope

- Collapsing a location or a proxy.
- Counting a proxy's alerts or searches on its row.

## Notes
