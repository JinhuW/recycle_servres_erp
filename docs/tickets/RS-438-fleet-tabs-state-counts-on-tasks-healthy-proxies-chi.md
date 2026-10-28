---
id: RS-438
title: Fleet tabs: state counts on Tasks, healthy proxies chip, real Tasks chip
type: bug
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/geoduck-2
pr: https://github.com/JinhuW/recycle_servres_erp/pull/970
version: 1.373.2
related: []
---

## Ask

> A few UI update:
>
> 1.  add a count for each status:
> [Image #1]
> 2. [Image #2] it should show the healthy count
> 3. fix the tasks 0 issue: [Image #3]

Image #1 is the Tasks tab's state segment (All · Running · Due · Done ·
Cancelled · Expired). Image #2 is the Proxies tab chip reading `0`. Image #3 is
the Tasks tab chip reading `0` while the table showed two running searches and
several overdue waiting probes.

## Context

All three live in Monitors ▸ Facebook (`pages/desktop/DesktopCoordinator.tsx`
and `pages/desktop/fleet/FleetTasksTab.tsx`).

- The state segment above the task table had labels only.
- The Proxies chip counted proxies whose health state is `down`, so a healthy
  fleet read `0` and looked empty.
- The Tasks chip (`useTabCounts`) counted only `ready` tasks of kind `search`
  already due. Running (leased) tasks were never counted, and the overdue
  waiting rows in the screenshot were `probe` tasks, dropped by the kind
  filter. The chip disagreed with the table's own Running and Due segments.

## Acceptance criteria

- [x] Each Tasks state segment button shows its count, computed with the item
  and search filters applied (state filter ignored), matching the rows that
  segment shows.
- [x] The Proxies tab chip shows the number of proxies whose health state is
  `up`, in neutral styling.
- [x] The Tasks tab chip is running (leased) plus due now (ready, `due_at <=
  now`), every kind: the same rows as the table's Running and Due segments. It
  is styled hot while any task is due.

## Out of scope

Changing what the segments filter; the Cities and Analysis chips.

## Notes

The warn colour on a chip (`.fleet-chip-hot`) never rendered: `.chip.muted`
in `tokens.css` outranks a single class. Raised to `.chip.fleet-chip-hot`.
