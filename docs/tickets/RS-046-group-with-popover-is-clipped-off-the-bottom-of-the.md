---
id: RS-046
title: Group-with popover is clipped off the bottom of the Payments table
type: bug
status: in-review
priority: P2
created: 2026-09-13
reporter: Jinhu
branch: fix/pair-picker-clipped
pr:
version:
related: [RS-005]
---

## Ask

> fix it

Said on 2026-08-31 in reply to being told that a `dev` → `main` release review
had found the "Group with" popover clipped by its scroll container, that this
makes manual transaction grouping unusable for rows lower in the list, and that
it is live on production.  The fix was written that day as #238 under RS-009 /
v1.116.1, but the PR sat unmerged while both numbers were taken by other work.
On 2026-09-13, asked to review everything not yet on `dev`, Jinhu had the
forgotten fix re-cut on today's code:

> start your recommendtation

## Context

`PairPicker` — the candidate list behind "Group with" — renders at
`position: absolute; top: calc(100% + 4px)` inside a `<td colSpan>` that sits
within `.table-scroll`. That container is `overflow-x: auto; overflow-y: hidden`,
so anything extending past the table's bottom edge is sheared off. For any row
in the lower part of the list the candidate rows are not merely awkward to
reach — they are not rendered anywhere the user can click, so manual grouping
cannot be completed at all.

The same bug was already found and fixed once. `PoPicker`, in the same file,
was converted to `position: fixed` in v1.103.0 ("unclip the PO picker", #210),
and carries a comment explaining why CSS alone cannot rescue it: `overflow-y:
visible` next to `overflow-x: auto` computes back to `auto`, so the popover has
to leave the scroll container entirely. Removing `overflow-x` is not an option
either — the table declares `min-width: 1080px`.

`PairPicker` shipped in the same release, written from `PoPicker`'s shape, and
did not inherit the fix. Since then a third picker (`RecordPicker`, the
internal-transaction filer) was written by copying `PoPicker`'s placement
arithmetic again. Manual grouping has therefore never worked from the lower
rows since the feature launched.

Found by the release review that produced [RS-005](./RS-005-release-review-findings-before-the-prod-cut.md);
deferred there as one of the non-blocking findings.

## Acceptance criteria

- [ ] Expanding a transaction near the **bottom** of a long Payments list and
      clicking "Group with" shows the full candidate panel, with every row
      clickable.
- [ ] Scrolling the table with the panel open keeps it anchored to its button.
- [ ] A row near the top still opens the panel **downward**.
- [ ] The PO picker ("Link…") and the record picker are unchanged in behaviour
      from every row position.
- [ ] The placement arithmetic is covered by unit tests that fail if a flip or
      clamp clause is removed.

## Out of scope

The other deferred findings from the RS-005 review.  This ticket is the popover
only.

## Notes

The fix is #238's code commit cherry-picked onto today's `DesktopPayments.tsx`;
the one addition is that `RecordPicker` — which did not exist on 2026-08-31 —
now uses the same shared `placePopover` helper instead of its own copy of the
arithmetic.  The helper sits beside its consumers in `pages/desktop/`, not in
`lib/`, because nothing else in the repo positions a popover.

The z-index moves 30 → 90 to match `PoPicker`. The ladder in `desktop.css` is
`.sel-bar` 80, the fab family 90, `.tweaks-pop` 95, `.modal-backdrop` 100, so 90
clears the selection bar and stays under modals.
