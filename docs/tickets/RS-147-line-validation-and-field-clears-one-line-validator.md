---
id: RS-147
title: "Line validation and field clears: one line validator, CHECK constraints, editor-managed fields can be cleared"
type: bug
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/line-validation
pr: "#465"
version: 1.197.1
related: [RS-136, RS-146]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 6a of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`, covering
review findings M12 and M15.

## Context

- **M12: three doors, three different sets of field checks.**
  - `POST /api/orders` checked no number at all. A negative unit cost was
    stored, and a qty of 0 reached the CHECK as a bare "A line value is out of
    range".
  - PATCH had a `badLine` closure covering qty, unit cost and sell price.
  - The inventory editor added health but not rpm.
  - Nothing stopped a negative `unit_cost` or `total_cost` in the database.
    Prod had none on 2026-10-02.
- **M15: a blanked field in the PO editor came back.** PATCH wrote every spec
  field with COALESCE, so the `null` the drawer sends for a cleared dropdown
  read as "no change". The save reported success and the value reappeared.
  RS-136 fixed this in the inventory editor; the PO editor still had it.
  Separately, the material-edit test compared the raw value sent, not what
  lands. An echoed `null` on a COALESCE column counted as an edit and could
  send a purchaser's submitted PO back to Draft for a change that never
  happened.

## Acceptance criteria

- [x] One `validateLineInput` (`lib/orderInput.ts`) checks the lines on POST,
      PATCH `lines`/`addLines` and the inventory editor:
      - `qty` is a whole number of at least 1, and `unitCost` is 0 or more.
        Both are required on create.
      - `sellPrice` is 0 or more; 0 unprices the line.
      - `health` is 0–100 and `rpm` is a whole number above 0.
      - Text fields are strings with a generous length cap.
      - POST errors carry the line number.
- [x] Migration 0149 adds `CHECK (unit_cost >= 0)` on `order_lines` and
      `CHECK (total_cost IS NULL OR total_cost >= 0)` on `orders`.
- [x] In PO PATCH, the editor-owned fields take a presence sentinel: present
      means it lands (null clears), absent keeps it. Those fields are brand,
      capacity, type, generation, classification, rank, speed, interface, form
      factor, description, item type, chip #, health and rpm. Part #, serial #,
      condition, category, qty, unit cost and the scan fields keep COALESCE.
- [x] A full-echo save of an untouched line changes nothing and keeps a
      submitted PO's stage. Clearing a field clears it and counts as a
      material edit.

## Out of scope

- Frontend changes. A blank qty is already caught before sending by the
  drawer's required-fields gate (`lineRequirements`), in translated text.

## Notes

- The synthetic part-number rebuild reads each spec as it will be after the
  UPDATE, so a cleared brand no longer resurrects in the rebuilt part number.
