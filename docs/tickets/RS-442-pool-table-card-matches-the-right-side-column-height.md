---
id: RS-442
title: Pool table card matches the right-side column height
type: bug
status: done
priority: P3
created: 2026-10-28
reporter: jinhu
branch: JinhuW/langouste
pr: 976
version: 1.375.1
related: []
---

## Ask

> Set the same hight with the right side.

(Sent with a screenshot of `/#/fleet/pool`, the accounts table card outlined
in red and a blank gap under it.)

## Context

On the manager view of the account pool (`FacebookAccountPool.tsx`) the
accounts card stopped at a fixed ~10-row scroll height
(`.fp-accounts .fp-table-wrap { max-height: calc(10 * 41px + 34px) }`), while
the aside beside it — Recent activity plus Pool rules — runs taller. `.fp-split`
aligns its columns to the start, so the card ended well above the aside and
left an empty band under the table.

## Acceptance criteria

- [x] On wide screens the accounts card's bottom edge lines up with the aside's.
- [x] The table's scroll area grows to fill that height; header stays pinned,
      the count footer sits at the bottom.
- [x] The table never sets the row height itself (65 rows don't stretch the aside).
- [x] Below 1190px (single column) the old ~10-row scroll height is kept.
- [x] Tracker and WeChat pages, which also use `.fp-split`, are unchanged.

## Out of scope

Changing the aside's content or the number of activity entries.

## Notes

A pool-only modifier, `.fp-pool-split`, carries the change so the shared
`.fp-split` stays as it is. The table keeps a 10-row minimum, so a short aside
stretches to the table instead.
