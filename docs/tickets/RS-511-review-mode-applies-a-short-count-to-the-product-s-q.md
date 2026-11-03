---
id: RS-511
title: Review mode applies a short count to the product's qty
type: story
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/goatfish
pr: 1063
version: 1.410.0
related: []
---

## Ask

> In the po review mode, if the count does not match the actual count then it should have a buttom to apply the chanage.

## Context

Review mode (`apps/frontend/src/pages/desktop/DesktopBoxCheck.tsx`) counts each
PO line against the box. The count stepper caps at the line's qty, so a count
that "does not match" is always short. Approve sets only the lines counted 0 to
0. A short line (1 ≤ count < qty) keeps its PO qty. The Finish card listed it
with "Edit them to what arrived, or approve as counted", and the only way to fix
it was the Edit drawer, where the qty had to be typed again and the tick was
reset.

## Acceptance criteria

- [x] When a product's count is below its qty and above 0, the Counted cell
      shows an **Apply N** link under the stepper, in the same style as the price
      cell's "Use $…".
- [x] Clicking it sets the PO line's qty to the count. The line stays checked at
      the new qty, and the page reloads with a toast.
- [x] A line with serials on file opens the Edit drawer with qty already set to
      the count. The manager picks which serials to drop (the serial count must
      equal qty), and nothing is guessed.
- [x] A line held by a shipped sell order shows no button.
- [x] The Finish card's short list has an **Apply all counts** button. It applies
      every short line that has no serials and isn't held, in one PATCH.
- [x] Nothing shows while the page isn't ready (archived, or checks not loaded).

## Out of scope

- Counts above qty: the stepper caps at qty, and extra units are an Edit.
- Approve still doesn't apply short counts on its own. The manager chooses.
- Mobile has no review mode.

## Notes

Plan: `~/.claude/plans/cosmic-baking-candy.md`. No backend change: it is the
same `PATCH /api/orders/:id` line write that Approve's zeroing uses.

Applying the count also ticks a short line that wasn't ticked yet, because the
click says this is what arrived. The drawer's `confirmEdit` used to reset the
tick on any qty change. It now keeps the tick when the qty goes down, so the
serial path ends checked like the direct one.
