---
id: RS-009
title: Payments row carries the whole PO decision inline
type: story
status: in-review
priority: P3
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-224801
pr: 239
version: 1.116.0
related: []
---

## Ask

> Help me polish the button on the side or place them in a better location.
> agline them at least

Reported with a screenshot of the desktop Payments queue, `PURCHASE ORDER`
column: the `Link…` and `Ignore` buttons start at a different x on every row,
and on the `CW Enterprises` row — the one carrying `Likely PO-1389 · 4d apart` —
`Ignore` has wrapped onto a second line and made that row taller than its
neighbours.

Shown three ways to align the controls in place, Jinhu chose none of them:

> [link...] only in fodler view. The inline view only show a star has a possible
> link.

## Context

The last column carries the entire linking decision inline: a match badge
(`Likely PO-1389 · 4d apart`, `1 possible PO`, `2 possible POs`, or
`Same payment · …`), then `Link…`, sometimes `Not it`, and `Ignore` — inside an
`inline-flex` with `flex-wrap: wrap`.  Every control is therefore positioned by
the width of the badge to its left, and the badge's width varies per row.  No
amount of gap tuning fixes that; only removing the variable-width content from
the cell does.

The expanded row — the "folder" behind the chevron — already holds the ranked
candidate list with a `Link` per PO (`MatchList`), so the linking decision has a
home that can afford the width.  What the queue row actually needs is one bit:
*is there a suggestion waiting here?*

## Acceptance criteria

- [ ] The `PURCHASE ORDER` cell of an unlinked row contains a star marker and
      `Ignore`, nothing else.  `Ignore` starts at the same x on every row.
- [ ] No row in the table is taller than any other, in either locale and at
      either density.
- [ ] The star distinguishes a single high-confidence match from "candidates
      exist", and is absent when the server found nothing.  Its tooltip names
      what was found.
- [ ] Clicking the star opens the row.  Clicking `Ignore` does not.
- [ ] `Link…` (manual PO picker), `Group` and `Not the same` all work from the
      expanded row.  A row with no suggestions can still be linked by hand.
- [ ] The pair-candidate block appears above the suggested-PO list, preserving
      today's rule that grouping outranks linking.

## Out of scope

Any change to how matches are computed, ranked or scored — this is a placement
change only.  The mobile and vendor shells have no Payments screen.

## Notes

`Not it` disappears: it dismissed an inline claim about a specific PO, and with
no such claim in the row there is nothing left to dismiss.  `Not the same`
survives, moving into the folder next to `Group`.

`MatchList`'s per-candidate button links immediately, so it drops the ellipsis
that promised a picker; `Link…` keeps it, being the one button that opens one.

Plan: `~/.claude/plans/crystalline-knitting-kitten.md`.
