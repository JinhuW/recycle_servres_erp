---
id: RS-549
title: RMB Flow balance runs per manager when one is selected
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/sole-2
pr: 1108
version: 1.427.0
related: []
---

## Ask

> Help me understand the balance in this screenshot, seem does not match the closing

> Yes, When user select a user, it should update for each manager.

## Context

On `#/accounting`, the band's Opening and Closing follow the selected manager
(`GET /api/accounting/summary`), but the book's Balance column ran over every
entry before any filter (`GET /api/accounting/entries`), by design since
v1.317.0. With Jinhu selected, the newest row read ¥3,759,407.82 under a Closing
of ¥2,123,329.75. The difference was Tim Wu's ¥1,636,078.07, whose rows were
hidden but still counted.

## Acceptance criteria

- [x] With a manager selected, each row's Balance is that manager's received
      minus paid, from their first entry through that row.
- [x] With a manager selected and the period ending on or after their newest
      entry, the newest row's Balance equals Closing, when no table filter hides it.
- [x] With no manager selected (All), Balance stays the company-wide book.
- [x] Direction, kind, method, review and search filters, and the period, still
      hide rows without changing any balance.
- [x] Voided entries show no balance and do not count.
- [x] The Balance column's hint says whose balance it shows, in English and Chinese.

## Out of scope

The band's figures and Held by, which were already correct. The phone page,
which shows no running balance. Renaming the column.

## Notes

The owner chose a per-manager balance over keeping the company-wide figures and
relabelling the column. The same entry now shows a different Balance under All
and under its manager, which is the accepted cost.
