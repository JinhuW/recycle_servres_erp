---
id: RS-007
title: Long activity log leaves a dead gap above Order status
type: bug
status: in-progress
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-125858
pr:
version:
related: []
---

## Ask

> fix this ui issue:
>
> when the activity are too long, It cuase the Order details part has a huge gap
> with the "rder status"

Reported with a screenshot of the desktop PO edit page: the Order details card
ends at its cost breakdown, an empty band roughly a screen tall follows, and the
Order status bar sits below it while the Activity panel (47 events) runs on.

## Context

The side column's "scroll inside your own card" rule is positional —
`.oe-side > :nth-child(2)` in `desktop.css` is *meant* to be the activity log and
carries its `max-height` plus internal scroll.  But the aside has a conditional
middle child: the manager-only payments ledger, which renders `null` until a bank
transaction is linked to the PO.  On a PO that has one, the ledger takes child 2,
the cap lands on the wrong card, and the activity log grows to its full natural
height.  (The log itself also renders `null` until its fetch resolves, so the
child count moves 1 → 3 during load — no positional selector can be right through
that window.)

The gap is where that surplus goes.  `.oe-body` is a 2×2 grid whose side column
spans both rows; with rows `1fr auto`, the flexible items row absorbs everything
the tall side column demands, and the items card is `align-self: start`, so the
surplus opens up underneath it instead of pushing it around.

## Acceptance criteria

- [ ] On a PO with a long activity history, the Activity card scrolls internally
      and stops at its height budget — including when the payments ledger card is
      present above it.
- [ ] The Order status bar sits directly beneath the Order details card
      regardless of how tall the side column is.
- [ ] The mobile order detail screen, which shares the activity component, is
      unchanged.

## Out of scope

Rebalancing the height budget itself (`--oe-rows` / `--oe-row-h`) — the cap is a
reasonable one once it actually applies.

## Notes

The fix is in two parts: class-based side-column selectors
(`.oe-side-activity`) so the cap can't slide onto a sibling, and grid rows
`auto 1fr` with `align-self: start` on the action card so any residual surplus
lands *below* the Order status bar rather than above it.
