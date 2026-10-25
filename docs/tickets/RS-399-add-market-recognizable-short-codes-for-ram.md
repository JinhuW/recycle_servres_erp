---
id: RS-399
title: Add market-recognizable short codes for RAM
type: story
status: in-review
priority: P2
created: 2026-10-25
reporter: jinhu
branch: feat/ram-short-code
pr:
version: 1.347.0
related: [RS-122, RS-209, RS-214, RS-229, RS-246]
---

## Ask

> I would like to add a short code for the ram. 
>
> The short code is a code that market can recognize it 
>
> for example.
>
> Micron. It will use the CHIP 3 digit 
> Samsung It will use last 3 digit for the part number before -, for example, M393A2G40DB0-CPB0Q -> DB0
> SK is same with Samsung, but it is not the last 3 digit. HMA42GR7MFR4N-TF -> MFR instead
>
> plan first

> Let we start the implementation. 
> But the Micron Chip number is not defined for all micron ram yet

> In the sell order price bid template.
> I hope the ram can group by the short code in the same speed, rank, and brand case. 
>
> The count can be sum

## Context

RAM already stores Part # and Chip #. Micron chip markings are normalized to
three-letter die codes (v1.231.0); some remain unknown, and one module part
number can carry different dies. Samsung and SK Hynix market codes are
segments of the module part number. A calculated display shares these rules
across forms, inventory and selling without another stored field. Inventory
Chip # entry lets staff record missing Micron markings without reopening the
PO editor.

## Acceptance criteria

- [x] Micron D9VPP / VPP yields VPP; a missing or unrecognized chip marking
      has no short code and the RAM form explains that the chip is needed.
- [x] Samsung M393A2G40DB0-CPB0Q yields DB0; SK Hynix
      HMA42GR7MFR4N-TF yields MFR. Recognized separator-free spellings agree.
- [x] Desktop and phone RAM forms show a read-only Short code that updates
      as Brand, Part # or Chip # changes.
- [x] Inventory and sell-order displays carry the code; grouped rows list
      distinct codes from their visible lots rather than choosing one.
- [x] Inventory exports and vendor bid sheets include Short code. The
      vendor's filled sheet still imports correctly.
- [x] Codes are computed from existing data; inventory grouping, required
      fields and saved source values remain unchanged.
- [x] The vendor RAM bid sheet combines matching Brand + Short code + Speed +
      Rank, with Capacity, Generation, Type and Class kept separate, and sums
      quantities across lots and part numbers. Unknown codes keep their prior
      grouping, separate from known ones.
- [x] Grouped rows list every source part number; Review mode's returned-sheet
      matching reaches every included part and distinguishes Micron chip codes
      that share one part number. Packing rows and product numbers stay intact.
- [x] Focused tests, typechecks and build pass; release documentation updated.

## Out of scope

Inventing unknown Micron dies, new historical backfills or online lookups;
manual short-code overrides; unsupported vendor numbering schemes (including
SK Hynix HMC DDR5); using a short code as an inventory product or market-price
identity.

## Notes

Approved plan in the conversation, 2026-10-25. Missing Micron chip data stays
unknown until a marking is recorded; the existing learned chip suggestion
continues to help new entry. No migration is needed.

Initial verification: 156 focused backend tests across eight files, the frontend suite,
workspace typechecks and production build. Browser checks exercised the actual
desktop and phone RAM fields with mocked APIs, including unknown Micron, live
chip edits and Chinese labels. No production data was modified.

Follow-up request extends the approved implementation: bid-sheet grouping now
uses the code together with the complete RAM spec. Missing Micron codes keep
the prior grouping. Returned-sheet prices must match both full part number
and any short codes the sheet names; older sheets without the column retain
part-number matching.

Follow-up verification: 135 backend tests in seven files passed, including
summed bid rows, spec/code separation, zero-quantity exclusion, source part
expansion, distinct Micron die prices in Review mode, older quote formats and
packing product numbers. Workspace typechecks and whitespace checks passed.
