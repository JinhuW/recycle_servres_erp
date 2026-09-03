---
id: RS-015
title: payments right side reads as a mass
type: task
status: done
priority: P2
created: 2026-09-03
reporter: Jinhu
branch: session/20260902-140951
pr: 247
version: 1.120.0
related: []
---

## Ask

> refine the UIUX in the payment page.
>
> [screenshot of the desktop Payments ledger, Unlinked tab]
>
> The right size looks in a mass.

## Context

The screenshot is the default view: the Unlinked queue, ten rows deep.  Four
things pile up on the right of every row.

The **Status** column repeats the tab.  Filtering to Unlinked and then printing
an amber "Unlinked" chip on all ten rows spends a whole column saying what the
selected tab already said.

The **Purchase order** column carries both the verdict and the actions — a match
badge, a primary button, a dismiss button and Ignore, all in one cell at the
same weight.  About twenty-five buttons are on screen at once and none of them
is the obvious one to press.

Those actions **wrap**.  On the rows that carry a match badge (CW Enterprises,
Digital Spaceport in the screenshot) `Ignore` drops to a second line, so those
rows stand a line taller than their neighbours and the table steps down the
page.  The comment in the code shows this was already fought once: a stacked
layout was replaced by a wrapping one, which moved the stepping rather than
removing it.

And because the buttons are left-aligned inside a cell whose width follows its
content, the `Link…` buttons sit at five different x positions.  There is no
right-hand column to read — only a ragged field.

Status and Purchase order turn out to be one question asked twice: *what is this
money attached to?*  Merging them frees the seventh column for a proper actions
rail.

## Acceptance criteria

- [x] The Status column is gone; one column states each payment's status —
      a linked PO with its cost, a suggested PO with how far apart it is,
      `Transfer`, `Ignored`, or `Unlinked`.
- [x] Actions live in their own right-aligned column and never wrap; every row
      in the table is the same height.
- [x] At rest each row shows at most one action button, and every row's button
      sits at the same x.
- [x] `Ignore`, `Not it` and `Not the same` appear when the row is hovered or
      when anything inside it takes keyboard focus, and are reachable by
      keyboard alone.
- [x] On a device without hover, the secondary actions are always visible —
      touch tablets get this shell, not the phone one.
- [x] Linking, grouping, ignoring, the PO picker and the expanded row detail all
      behave exactly as before.

## Out of scope

- The stat tiles, the filter strip, and the expanded row's detail panel.
- The Source column's coloured pills — left half of the row, not what was
  reported.
- Copy rewrites (`Same payment · …`) and moving the owner / record tags into the
  payee cell: both were considered during planning and cut as editorial calls
  that were not asked for.

## Notes

Two decisions confirmed with Jinhu before planning: merge Status into the
Purchase order column rather than only suppressing the repeated chip, and reveal
secondary actions on hover rather than collapsing them into an overflow menu.

Plan reviewed by a subagent before implementation; it moved the primary button
to the right-most position (right-aligning a rail pins only its right edge, so
a leading primary would still have landed at a different x per row shape) and
added `pointer-events: none` to the hidden actions, which would otherwise have
been invisible but clickable.
