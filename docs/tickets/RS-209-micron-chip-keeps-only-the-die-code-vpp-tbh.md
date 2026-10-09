---
id: RS-209
title: Micron Chip # keeps only the die code (VPP, TBH, …)
type: story
status: in-progress
priority: P2
created: 2026-10-09
reporter: jinhu
branch: feat/micron-chip-die-code
pr:
version:
related: [RS-122]
---

## Ask

> SO this is only for the desktop and laptop. Help me refine the CHip number for the Micron.
> I meant update the chips numbertp VPP OR TBH ..

## Context

This follows a DDR4 price list Jinhu pasted (三大牌 / 三星 / 镁光 / 海力士).
The list prices desktop and laptop sticks by brand, capacity, rank × width,
speed and **die code**. For Micron, the die code is the FBGA code printed on
the chips: 8G 1R8 is VPP / TBH / TZV / WSM / WFL / BPJ, and 16G 1R8 is
XPF / CJV. Asked which lines to cut down, Jinhu chose **all Micron lines**:
desktop, laptop and server.

Purchasers record a Micron stick's whole chip marking in Chip #. That is the
date/lot code on the chip's top line and the FBGA code under it: `8KE75
D9VPP`, `0NJ45D9WSM`, `2EF75D8CJV`. Every line therefore carries a unique
date code, so the column groups nothing. The RS-122 chip auto-fill
(`POST /api/market/chips`, "most POs wins" per part number) then copies one
stick's date code onto the next line of that part.

Chip # is written in one place, `canonChipNumber` in
`apps/backend/src/routes/orders/shared.ts`, which upper-cases. It covers PO
create, PATCH edits and PATCH `addLines`. Label OCR upper-cases it in
`ai/normalize.ts`. `0096_chip_number_upper.sql` backfilled that rule.

In prod on 2026-10-09 there were 420 Micron lines, 325 of them with a Chip #.
**243** end in a Micron die code (`[CDZ][89]` + three letters) and get cut
down to it. The other **82** don't, and stay as typed (see Notes).

## Acceptance criteria

- [ ] A Micron line's Chip # is stored as the 3-letter die code, however it
      arrives: typed, pasted, label OCR, or chip auto-fill. `8KE75 D9VPP` →
      `VPP`, `D9XPF` → `XPF`, `0DJ75C9BJR` → `BJR`.
- [ ] Existing Micron lines are backfilled by a migration.
- [ ] A value with no die code at its end is left as typed.
- [ ] Other brands' chip numbers are only upper-cased, as before.
- [ ] Re-saving a submitted PO that still holds a raw marking in an open tab
      doesn't count as an edit, so the PO stays at its stage.
- [ ] On the desktop line drawer and the phone form, leaving the Chip # field
      on a Micron line shows the die code.

## Out of scope

- **Kingston / Other / Crucial modules built on Micron chips.** Offered as an
  option and not picked. Their Chip # keeps the full marking.
- **The 82 Micron values with no die code** (`1`, `DDR5`, `MICRON`, `NA`,
  part numbers typed into the wrong field, …). They need a person who has the
  stick in hand.
- **Re-canonicalising Chip # when only the brand changes.** That covers the
  inventory editor's brand field, or an API PATCH that sends `brand` without
  `chipNumber`. The PO editors echo every field, so the next editor save fixes
  it.
- **Transfer splits drop Chip #.** Found while planning:
  `inventory.ts`'s transfer split copies a line without `chip_number` or
  `serial_number`. It belongs in its own ticket.

## Notes

- Mid-build, Jinhu added: "The Chip number list here is just popular chips
  number, But not measn all chips must in this list". So the die code is read
  by its **shape** (`[CDZ][89]` + three letters at the end), not checked
  against the price list. Prod already holds about 40 other Micron dies
  (RGV, SRK, QBJ, PQL…).
- The rule lives once, as `chipMarkingCanon` in `@recycle-erp/shared`. The
  migration has a SQL twin, and a test runs the migration file against the
  TS rule.
- The D8/D9/C9/Z9 prefix is dropped, as the price list does. Two dies that
  differ only in prefix would merge. Accepted.
- The backfill discards the date codes for good. A rollback file of the 243
  prod rows is exported before the dev→main release.
- Prod Micron values the rule leaves alone, as of 2026-10-09 (82 lines):

  | Value | Lines | POs |
  |---|---|---|
  | `1` | 23 | PO-1346, 1359, 1364, 1368, 1391, 1471, 1483 |
  | `DDR5` | 11 | PO-1383, 1406, 1418, 1433, 1438, 1458 |
  | `MICRON` | 9 | PO-1360, 1458, 1471, 1477 |
  | `NA` | 8 | PO-1445, 1447, 1460, 1461, 1467, 1473 |
  | Micron part numbers (`MTA18ASF2G72PDZ-…`, `MTA36ASF4G72PZ-…`, `MTA72ASS8G72LZ`) | 7 | PO-1442 (6), PO-1396 |
  | `7DB47 DGTGV` | 2 | PO-1458, 1483 |
  | `MICRON CHIP` | 2 | PO-1362 |
  | `OTHER` | 2 | PO-1471 |
  | `SHIELD` | 2 | PO-1458 |
  | `1HR75D8PJ` (letter missing) | 1 | PO-1483 |
  | `7TH7509VHP` (0 for D → VHP) | 1 | PO-1483 |
  | `MICRON S9SRK` (S for D → SRK) | 1 | PO-1489 |
  | `K4AAG085WBBCWE` (a Samsung chip) | 1 | PO-1471 |
  | `0`, `2`, `16`, `D5`, `DDR6`, `M`, `N/A`, `UNKNOW`, `UNKNOWN`, `BHB`, `WFH`, `PC4-2666V-RD1` | 12 | PO-1439, 1391, 1428, 1426, 1477, 1397, 1440, 1491, 1400, 1486, 1413 |
