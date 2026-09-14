# Denver 8/5 count reconciliation — and the PO-1370 overlap

Applied 2026-08-06 against **production**, attributed to Tim WU.
Source: `Denver_System_Update_20260806.xlsx`.

## What "inventory" means here

There is no inventory table — `order_lines` **is** the inventory, and stock is
the `Done` + `In Transit` slice.  Denver RAM at those two statuses summed to
exactly **472**, matching the spreadsheet's system total, which is how the
export slice was identified.  `Draft` lines are *not* stock; `Sold` is terminal.

## `qty = 0` is impossible

`order_lines.qty` carries `CHECK (qty > 0)` (`0001_init.sql:58`) and every route
rejects a non-positive qty.  A count sheet that says "set qty to 0" cannot be
applied literally — the line has to be **deleted**, or marked `Sold` (which lies
about a sale and pollutes reporting).  We delete, writing a `line_removed`
`order_event` carrying the part number, qty and unit cost *before* the delete,
because `inventory_events` cascade away with the row.

## What was applied

| Step | Effect |
| --- | --- |
| 1 — add | New **PO-1371** (`done`, WH-DEN, Tim WU): 18 lines, **+70** units |
| 2 — adjust | 12 parts retargeted, **net +32** |
| 3 — retire | 4 lines deleted, **−10** |

Denver RAM went **472 → 564** across 84 part numbers.

Two part numbers spanned two lines each, so the plan's single target qty needed
a per-line rule:

- `HMA82GR7MFR4N-UH` 13 → 5: two PO-1364 lines (8 and 5).  The **8-unit line was
  deleted** — those are the x8 modules the count reclassified to
  `HMA82GR7MFR8N-UH`, which PO-1371 adds as 8 units.  Net zero, not a write-off.
- `HMA81GR7AFR8N-UH` 32 → 33: two PO-1368 lines (14 and 18); the 18 became 19.

## The trap: PO-1370

**PO-1370 is a draft PO covering this same count, and it was deliberately left
untouched.**  Denver reads 564, not the sheet's 613, because PO-1370 holds the
other 49 units as a draft.  84 + its 8 parts = 92 lines; 564 + 49 = 613.

Advancing PO-1370 **as it stands** puts Denver at **647 — 34 over the count**,
because 5 of its 13 lines duplicate work now applied elsewhere.  Before it is
advanced, drop these:

| Line | Qty | Why it must go |
| --- | --- | --- |
| `M393A2G40DB0-CPBOQ` | 15 | Step 3 retired this suffix variant; the units live on `-CPB`, now 27 |
| `M393A1G43DB0-CPB` | 6 | Already applied as Step 2 adjust 2 → 8 |
| `M393A2K40BB1-CRC0Q` | 4 | Already applied as adjust on `CRCOQ` (letter O) 4 → 8 — this is the digit-0 misspelling |
| `MTA9ASF1G72PZ-2G9E1VI` | 4 | Already applied as adjust on `-2G9E1UI` 1 → 5 — `VI`/`UI` variant |
| `HMA41GR7MFR4N-TF` | 5 | Not on the count sheet at all; needs a physical check |

Remove those 5 (34 units), and the remaining 8 lines total exactly 49 — advance
it and Denver lands on **613**.

The general lesson: quantities entered as **new lines** when they are really
**deltas on an existing line** are invisible until someone sums both, and
one-character part-number variants (`0`/`O`, `I`/`J`/`U`, `AZ`/`PZ`) silently
split one product across two lines.  Compare a count plan against draft POs, not
just against stock, before applying it.

## Rollback

Pre-change snapshot of all Denver RAM lines:
`backup/den-ram-lines-before-20260806.csv`.  A full revert is that CSV plus
deleting PO-1371.  Railway's WAL archive is the backstop.
`pg_dump` cannot be used against this server from a Homebrew client — server is
18.4, local client 14.15.
