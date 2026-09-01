---
id: RS-009
title: Group-with popover is clipped off the bottom of the Payments table
type: bug
status: in-review
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: fix/rs-008-group-with-popover-clipped
pr: 238
version: 1.116.1
related: [RS-005]
---

## Ask

> fix it

Said in reply to being told that a `dev` → `main` release review had found the
"Group with" popover clipped by its scroll container, that this makes manual
transaction grouping unusable for rows lower in the list, and that it is live on
production.

## Context

`PairPicker` — the candidate list behind "Group with" — renders at
`position: absolute; top: calc(100% + 4px)` inside a `<td colSpan>` that sits
within `.table-scroll`. That container is `overflow-x: auto; overflow-y: hidden`
(`desktop.css:530`), so anything extending past the table's bottom edge is
sheared off. For any row in the lower part of the list the candidate rows are
not merely awkward to reach — they are not rendered anywhere the user can click,
so manual grouping cannot be completed at all.

The same bug was already found and fixed once. `PoPicker`, ninety lines above
`PairPicker` in the same file, was converted to `position: fixed` in v1.103.0
("unclip the PO picker", #210), and carries a comment explaining why CSS alone
cannot rescue it: `overflow-y: visible` next to `overflow-x: auto` computes back
to `auto`, so the popover has to leave the scroll container entirely. Removing
`overflow-x` is not an option either — the table declares `min-width: 1080px`.

`PairPicker` shipped in the same release, written from `PoPicker`'s shape, and
did not inherit the fix. Manual grouping has therefore never worked from the
lower rows since the feature launched.

Found by the release review that produced [RS-005](./RS-005-release-review-findings-before-the-prod-cut.md);
deferred there as one of the non-blocking findings, and picked up here.

## Acceptance criteria

- [ ] Expanding a transaction near the **bottom** of a long Payments list and
      clicking "Group with" shows the full candidate panel, with every row
      clickable.
- [ ] Scrolling the table with the panel open keeps it anchored to its button.
- [ ] A row near the top still opens the panel **downward**.
- [ ] The PO picker ("Link") is unchanged in behaviour from every row position.
- [ ] The placement arithmetic is covered by unit tests that fail if a flip or
      clamp clause is removed.

## Out of scope

The other deferred findings from the RS-005 review — `SPEC_PATCH_FIELDS`
category gating, suppliers list pagination, `escapeLike` on client search, the
UTC follow-up off-by-one, the client-error report budget, the `no_auto_pair`
asymmetry in pair matching, and the test-template poisoning in `helpers/db.ts`.
This ticket is the popover only.

## Notes

Plan reviewed before implementation, per the repo's plan-first workflow. Two
things the review changed: the shared placement helper was moved out of
`src/lib/` to sit beside its only two consumers (there is no third consumer
anywhere in the repo, so `lib/` was speculative), and the backend suite was
dropped from verification — this change is frontend-only and the backend tests
need Postgres on `127.0.0.1:5432`, which produces a misleading red in a fresh
worktree.

The z-index moves 30 → 90 to match `PoPicker`. The ladder in `desktop.css` is
`.sel-bar` 80, the fab family 90, `.tweaks-pop` 95, `.modal-backdrop` 100, so 90
clears the selection bar and stays under modals.
