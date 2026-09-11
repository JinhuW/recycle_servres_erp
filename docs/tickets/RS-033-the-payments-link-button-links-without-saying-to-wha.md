---
id: RS-033
title: The Payments Link button links without saying to what
type: bug
status: done
priority: P2
created: 2026-09-07
reporter: Jinhu
branch: feat/payments-link-picker
pr: 289
version: 1.133.0
related: [RS-015, RS-010]
---

## Ask

> The UI UX in this page is total wrong.
>
> The link button has not hit about what it will link with. also it should
> not link by default.
>
> Maybe be better to search first and the suggesion shows in the first.

(With a screenshot of a Payments row: `Aug 28 · PayPal · Digital Spaceport ·
-$2,660.00 · ● PO-1414 3d apart · [Link…]`, expanded to show "Suggested
purchase orders" with `PO-1414 $2,660.00 Sep 1 [3d apart] Stefen [Link…]`.)

## Context

Since RS-015 (v1.120.0) the actions rail on an unlinked transaction row ends in
a `Link…` button. That button does two different things depending on the row.
When the server found exactly one high-confidence candidate — the green
`● PO-1414  3d apart` chip — it posts the link to that PO the moment it is
clicked. On every other row it opens the PO picker, a searchable popover that
lists the ranked suggestions first and switches to free-text search as the
manager types.

Nothing on the button says which of the two it is. The ellipsis promises a
next step that, on the very rows where a wrong link costs the most, never
comes. The expanded row's "Suggested purchase orders" list has the same
problem in miniature: a `Link…` per suggestion that links on one click.

A link is an audited write (it stamps `linked_by`, fills the PO's transaction
ID, and logs an order event), so it has to be a choice the manager makes, not
a default the page makes for them. The picker already is the flow Jinhu is
describing — search on top, suggestions listed first — so the fix is to make
it the only path off the row and to label the buttons that do link directly.

## Acceptance criteria

- [x] `Link…` on a transaction row always opens the PO picker. It never posts
      a link on its own, whatever the server's confidence in the suggestion.
- [x] The picker opens on the ranked suggestions under a "Suggested purchase
      orders" heading (with "showing X of Y" when the list is capped) and
      switches the heading to "Search results" once the manager types. A row
      with no suggestions says so and invites a search, rather than reading
      as a failed one.
- [x] Clicking a PO in the picker links it, as today.
- [x] The per-suggestion button in the expanded row reads `Link PO-nnnn`, not
      `Link…`; it still links on one click, because it sits in that PO's own
      row next to its cost, date and purchaser.
- [x] `Not it` is gone from the rail. It existed only as the escape hatch from
      the one-click link; with that gone it would do what `Link…` does.
- [x] The status chip (`● PO-1414  3d apart` / "N possible POs"), grouping,
      ignoring, unlink, the internal-transaction picker and the expanded
      detail behave exactly as before.

## Out of scope

- Changing how suggestions are ranked or how confidence is computed
  (`banktx/match.ts`).
- Keyboard navigation inside the picker.
- The Sell-orders side of linking (RS-010's other direction).

## Notes

- The picker's height constant `PICKER_H` is shared with the
  internal-transaction popover, so the new heading lives inside the picker's
  scroll area and the popover's outer height does not change.
- Historical mentions of `Not it` in the v1.120.0 changelog section and in
  RS-015 are left as they were; `docs/FEATURES.md` is updated.
