---
id: RS-465
title: Confirm before removing a packed item from a sell order
type: story
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: JinhuW/searobin
pr: 1006
version: 1.387.0
related: []
---

## Ask

> In the sell order, once a packed item get removed, it will prompt an alerts.
> come with a dialog to confirm.

Asked which removal it meant (the editor's ✕, or Pack mode's unpack), the
owner answered "Both".

## Context

Taking a packed item off a sell order asked nothing:

- **Editor** (`DesktopSellOrders.tsx`): ✕ drops the line from the draft, and
  on save `prunePackRows` (`routes/sellOrderPack.ts`) deletes its tick for
  good. The editor never knew the line was packed.
- **Pack mode** (`DesktopSellOrderPack.tsx`): one click on a packed tick, for
  a lot or a whole product, unpacked it at once, behind only an Undo toast.

## Acceptance criteria

- [x] In the editor, ✕ on a packed line opens a dialog naming the part;
      Cancel keeps it, Remove drops it.
- [x] ✕ on an unpacked line, or one added in this edit, removes it at once.
- [x] In Pack mode, unticking a packed lot or a packed product asks first;
      Cancel leaves it packed, Unpack does what the tick did (Undo toast too).
- [x] Packing, scanning and the rest of the editor are unchanged.
- [x] Strings exist in en and zh.

## Out of scope

- A backend refusal to remove packed lines — the dialog is a guard, not a rule.
- Confirming qty edits on a packed line.
- Mobile: it has no sell-order editor or Pack mode.

## Notes

The editor reads `GET /api/sell-orders/:id/pack` alongside the order to learn
which lines are packed; a failed read just means no confirm.
