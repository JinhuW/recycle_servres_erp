---
id: RS-528
title: Count proxy crowding by exit IP, not by port
type: bug
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/proxy-crowding-by-ip
pr: 1088
version: 1.419.1
related: [RS-527]
---

## Ask

> btw, It all about the ip instead of the proxy itself.

## Context

RS-527 (v1.419.0) added the crowding dot to the Used by column, counting the
accounts on each proxy port. Several ports can exit from one IP, so accounts
sharing an IP across ports went uncounted.

## Acceptance criteria

- [x] The count adds non-parked ERP accounts and homelab workers across every row with the same exit IP.
- [x] Every row on that IP shows the dot, at the same 5 and above-10 thresholds.
- [x] The hover text names the exit IP, in en and zh.
- [x] A filter or search doesn't change the count.
- [x] A port with no known exit IP shows no dot and adds to no total.

## Out of scope

- Changing `max_accounts_per_proxy`, which still limits accounts per port.
- Grouping or sorting the table by IP.

## Notes

The IP is the row's latest `last.exit_ip`. A failed check has none, so that port
drops out of the count until it answers again.
