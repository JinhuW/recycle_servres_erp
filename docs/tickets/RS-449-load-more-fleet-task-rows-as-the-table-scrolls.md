---
id: RS-449
title: Load more fleet task rows as the table scrolls
type: bug
status: done
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/sailfish
pr: 986
version: 1.377.4
related: []
---

## Ask

> FIx the ui issue.
> [Image #2]
> auto waterfall refresh for the next page.

## Context

The Tasks tab (`/#/fleet/tasks`) showed at most 60 rows (`TABLE_MAX` in
`apps/frontend/src/pages/desktop/fleet/FleetTasksTab.tsx`). The footer read
"60 of 1241 tasks", and the remaining rows could not be reached. The screenshot
shows the table scrolled to its end at row 60. Every task in the range is
already in the browser, so the next page can come from the array the page holds,
with no new request.

## Acceptance criteria

- [x] Scrolling to the end of the task table adds the next 60 rows, and keeps
      adding them until every matching row is shown.
- [x] The footer's "{shown} of {n}" count goes up as rows are added.
- [x] Changing the state segment, item, search or range starts again from the
      first 60.
- [x] The 10 s poll does not throw away the rows already added.

## Out of scope

Server-side paging. The range is already loaded in full.

## Notes

The change reuses `lib/useSentinel.ts`, which the Activity page also uses, with
`.fleet-table-cap` as the observer root.
