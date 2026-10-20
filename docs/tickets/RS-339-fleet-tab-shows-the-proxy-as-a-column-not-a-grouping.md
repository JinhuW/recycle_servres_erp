---
id: RS-339
title: Fleet tab shows the proxy as a column, not a grouping
type: story
status: in-review
priority: P2
created: 2026-10-20
reporter: jinhu
branch: fleet-proxy-column
pr: 807
version: 1.309.0
related: [RS-335, RS-333, RS-332]
---

## Ask

> remove the group by the prots / proxy. let we add a new field for the proxy. 
> pls also note the proxy cities.

## Context

v1.305.0 (RS-335) laid the Fleet tab's workers table out under one divider
row per proxy (`ProxyRow` in `FleetWorkers.tsx`: port, exit IP, worker count,
*shared*), with that proxy's workers under it. The exit city was only in the
divider's tooltip. A flat table with the proxy on each worker's own row reads
faster, and the city belongs on the page rather than one hover away.

Every worker row already carries its proxy (`FleetAccount.proxy`: URL, exit
IP, city, region, ISP), so this is frontend only. The rs_console dashboard
already shows the proxy as a column with the city under it.

## Acceptance criteria

- [x] The workers table has no group rows: one row per worker, as before
      v1.303.0.
- [x] A **Proxy** column, after Worker, shows the port and exit IP
      (`:10014 · 138.226.192.110`), or *VM's own IP*. Under it is the exit
      city and region (`Palo Alto, California`), or *looking up exit…* /
      *exit lookup failed*. The ISP is in the cell's tooltip.
- [x] A worker whose exit IP another worker also uses is marked *shared*,
      with the "keep their cities and sweep times apart" tooltip.
- [x] The Proxy column sorts by port, with the VM's own IP last either way.
      With no sort, rows keep the fleet document's order.
- [x] The search box matches the proxy's port, exit IP, city and region.

## Out of scope

- Grouping or collapsing by proxy or by city.
- The worker page's Proxy detail (`ProxyExit`), which is unchanged.
- The rs_console dashboard, which already has a Proxy column.

## Notes

- "Note the proxy cities" was read as: show each proxy's exit city in the new
  field, not in a tooltip. The cities as the live fleet reported them are
  below.
- The Proxy cell keeps to two lines (`white-space: nowrap`), like the rows
  around it, so the table's fifteen-row cap still fits. With wrapping it
  broke into four lines.
- Checked against the live fleet: `/v1/fleet` pulled from the rs_console
  over SSH, served to a local backend by a stub, and driven in headless
  Chromium. 42 rows and no dividers. A sort by Proxy put each pair together
  and the VM's own IP last. A search for "palo alto" left the eight `ca-*`
  workers.
- Exit cities on 2026-10-20 (ipinfo, through each proxy). Every port
  carries two workers, the second with a `b` suffix:

  | Port | Exit IP | Exit city | Workers |
  | --- | --- | --- | --- |
  | 10001 | 48.46.192.126 | New York City, NY | homelab-1, homelab-1b |
  | 10002 | 48.46.254.146 | New York City, NY | ne-1, ne-1b |
  | 10003 | 9.249.126.93 | Ashburn, VA | mw-1, mw-1b |
  | 10004 | 9.249.124.148 | Ashburn, VA | west-1, west-1b |
  | 10005 | 72.1.190.152 | New York City, NY | sc-1, sc-1b |
  | 10006 | 72.1.143.239 | Seattle, WA | denver-1, denver-1b |
  | 10007 | 48.44.175.211 | New York City, NY | nyc-1, nyc-1b |
  | 10008 | 66.93.89.19 | Philadelphia, PA | phl-1, phl-1b |
  | 10009 | 45.58.221.17 | Washington, DC | wc-1, wc-1b |
  | 10010 | 45.58.216.8 | Washington, DC | va-2, va-2b |
  | 10011 | 172.252.99.178 | Boston, MA | bos-1, bos-1b |
  | 10012 | 216.133.169.150 | New York City, NY | nyc-2, nyc-2b |
  | 10013 | 9.142.77.158 | New York City, NY | nyc-3, nyc-3b |
  | 10014 | 138.226.192.110 | Palo Alto, CA | ca-1, ca-1b |
  | 10015 | 135.132.73.70 | Palo Alto, CA | ca-2, ca-2b |
  | 10016 | 135.132.73.204 | Palo Alto, CA | ca-3, ca-3b |
  | 10017 | 138.226.194.155 | Palo Alto, CA | ca-4, ca-4b |
  | 10018 | 138.226.5.43 | Parsippany, NJ | nj-1, nj-1b |
  | 10019 | 170.100.200.120 | Parsippany, NJ | nj-2, nj-2b |
  | 10020 | 138.226.4.234 | Parsippany, NJ | nj-3, nj-3b |
  | VM's own IP | 74.104.122.134 | Framingham, MA | se-1, va-1 |
