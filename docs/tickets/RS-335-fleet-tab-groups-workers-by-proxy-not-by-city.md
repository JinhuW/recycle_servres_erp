---
id: RS-335
title: Fleet tab groups workers by proxy, not by city
type: story
status: in-progress
priority: P2
created: 2026-10-20
reporter: jinhu
branch: fleet-group-by-proxy
pr:
version:
related: [RS-333, RS-334]
---

## Ask

> update the UI to group by the proxy instead of the city. The city can be not in the title of proxy.

## Context

v1.304.0 (RS-333) laid the Fleet tab's workers table out in three layers:
exit city, proxy IP, worker. Since RS-334 every proxy carries two workers,
so the proxy is the unit to manage. The city layer above it only made the
table taller.

## Acceptance criteria

- [ ] The workers table has one group level, the proxy. Its row shows the
      port, the exit IP, the worker count, and *shared* when it carries more
      than one worker. Each proxy's workers sit under it.
- [ ] The exit city is not on the proxy row. It is in the row's tooltip
      beside the ISP, and the search box still matches it.
- [ ] With no column sort, proxies run by port, then the VM's own IP last,
      and each proxy's workers by id. A column sort orders the proxies by
      their highest-ranked worker.

## Out of scope

- Collapsing a proxy.

## Notes
