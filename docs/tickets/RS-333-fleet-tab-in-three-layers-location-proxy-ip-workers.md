---
id: RS-333
title: "Fleet tab in three layers: location, proxy IP, workers"
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: fleet-three-layers
pr: 800
version: 1.304.0
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

- [x] Under each location divider, each proxy has a row: its port, exit IP
      and worker count. The exit's ISP is in the tooltip.
- [x] Each proxy's workers sit under it. A proxy with more than one worker is
      marked shared, and its tooltip says to keep their cities and sweep
      times apart.
- [x] Workers on the VM's own IP sit under one row of their own, and workers
      whose exit is still being looked up keep their proxy rows under the
      pending location.
- [x] With no column sort, proxies run by port and each proxy's workers by
      id. A column sort orders proxies by their highest-ranked worker and
      workers within each proxy, with locations kept as they are.
- [x] The worker subtitle no longer repeats the port or the shared-IP note.

## Out of scope

- Collapsing a location or a proxy.
- Counting a proxy's alerts or searches on its row.

## Notes

- `proxyLocations` (`lib/fleetView.ts`) returns the nested shape, locations of
  proxies of workers, and replaces v1.303.0's `ipPartners`.
- Checked against the live console through an SSH tunnel: nine locations.
  Palo Alto shows four IP rows, 10014 and 10015 marked shared with their
  pairs under them. The VM's own address is one IP too: se-1 (never
  deployed) and va-1 (retired) share its row and read as shared, which is
  true of that address.
