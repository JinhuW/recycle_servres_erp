---
id: RS-233
title: Pre-release review fixes for the v1.247 release
type: bug
status: in-progress
priority: P1
created: 2026-10-11
reporter: jinhu
branch: fix/release-1.247-review
pr:
version:
related: [RS-227, RS-228, RS-229, RS-230, RS-231, RS-232]
---

## Ask

> dev to prod change. Identfy all issues , fix them, then release to prod.

## Context

`/code-review max` ran over dev against main: v1.241.0 → v1.247.0, RS-227
(bid sheet without condition), RS-228 (RAM part-number decoder), RS-229 (RAM
family grouping), RS-230 (AI PO reviewer), RS-231 (Sold as a flag) and RS-232
(Market price-list import). Sixteen finders ran, then three verifiers and a gap
sweep. Most findings were reproduced with a probe or a failing test before the
fix.

| # | Finding | Verdict |
|---|---|---|
| 1 | AI review's label witness is `label_scans.extracted`, the scan's raw read; the line holds the part # `reconcileRamScan` corrected, so every corrected RAM line got an error-level `pn_label_differs` whose Apply wrote the misread back | **Fixed**: scan and re-read witnesses go through the same correction |
| 2 | Grouped Inventory synthesised each lot with the group's family label (`…-CTD*`) as its part #; sell orders saved it, `autoTrackParts` minted a junk Market row, Quick View came up empty | **Fixed**: the lot's own part # |
| 3 | 0173 is one-shot at the new container's boot; the old instance still settles POs to `sold` through the deploy overlap, a value the new code no longer reads | **Fixed**: 0174 trigger lands a later `sold` as `done` (works through a rollback too) |
| 4 | Apply sent a one-field PATCH, so `specConflicts` refused paired Form/Device fixes (SODIMM↔RDIMM can't be applied either way round) | **Fixed**: Apply goes through `cascadePatch` and settles the finding the cascade carried out |
| 5 | `ai_review_done` rendered as the raw kind, reached purchasers with issue counts, read as a blank `edited` row on Activity | **Fixed** |
| 6 | Apply PATCHed blindly; a concurrent edit by another manager was overwritten and recorded as applied | **Fixed** for the stale-card case: Apply re-reads the findings and refuses one no longer current. Not atomic server-side |
| 7 | Lock-order inversion: move/revert locks lines then supersedes the review; the worker locks the review then takes FK locks on the lines (40P01 reproduced) | **Fixed**: the worker takes the orders row first |
| 8 | Findings for a line deleted mid-run failed the whole review on the FK | **Fixed** |
| 9 | `stop()` didn't stop an in-flight drain; a stale reclaim had no fencing token | **Fixed** |
| 10 | Cost cap overshot by a first wave of four concurrent calls | **Fixed**: one call at a time until a cost is known, then each call in flight is reserved |
| 11 | `pn_misread` and `spec_mismatch` both raised from a misread decode; applying both corrupts the rank | **Fixed**: specs judged by the unique matching reading |
| 12 | Paid web lookups for placeholders and Mixed synthetic part #s; brand from OEM listings; `10K` RPM read as 10; numeric old scan values crashed the review; custom categories re-read with no prompt; cost findings never went stale; `pn_missing` hid the part # Apply writes; failed-review log lost its error; review's market value used a different basis than Market | **Fixed** |
| 13 | Kingston DDR3L (`KVR16LR11D4/16`, `KCP3L16SD8/8`) decoded only via a look-alike, so a scan rewrote a correct part #; Kingston kits decoded at kit size; SK Hynix VLP (`V`) not read; PC4/PC5 rates (25600) read as conflicts; the first decodable look-alike auto-applied with no ambiguity check | **Fixed** |
| 14 | `useRamPartFill` overwrote scan-read values equal to its own earlier fill | **Fixed**: a scan clears the hook's memory |
| 15 | `hynixLength` used the last dash, splitting `-VK-TF` from `-VKTF` | **Fixed** |
| 16 | `isCompleted` narrowed to Done counted Sold lots as active on the phone Inventory KPIs | **Fixed** |
| 17 | Desktop Sold chip counted only non-Done POs before a click; `soldOnly` emptied the purchaser preview | **Fixed** |
| 18 | `excludeStatus=Sold` from an older phone bundle hid sold POs at every stage | **Fixed**: excludes nothing |
| 19 | `/api/activity` still listed old `done → sold` rows | **Fixed**: one restaging helper for both feeds |
| 20 | Price sheets: first price-ish column won (List/Ext. Price), `编号` beat `型号`, hidden tabs read, merged title taken as header, second section read with the first header's columns, decimal comma read ×100, sparse sheet allocated GBs | **Fixed** |
| 21 | Market import: `美元` read as yuan; tab names and non-yuan currencies ignored; preview uncapped while apply refused >1000 | **Fixed**: dollars named outright win; any other currency is skipped; cap 5,000 at both, apply set-based |
| 22 | Bid import: a 0 matched as a $0 bid; a part under two line labels went `ambiguous`; an old per-condition sheet applied its last row to every condition | **Fixed** |
| 23 | AI cost-cap input stored `.5` as 5 | **Fixed**: read on blur |
| 24 | A misread *printed* field can flip a correct part # to another real one (HMA8/HMAA symmetry) | Kept: RS-228's acceptance criterion specifies the auto-correction; the scan notice shows it |
| 25 | `reconcileRamScan` fills blanks even while a conflict remains | Kept: RS-228 asks for both, and `scan.test.ts` asserts it |
| 26 | The part-#-vs-specs question is asked only by the drawer's Confirm and the phone's Add to order; Submit/Save of a line never confirmed skips it | Kept for a follow-up: needs the answer stored on the line through DesktopSubmit and the PO editor; the readout still shows the mismatch |
| 27 | Grouped export's Part # holds the family label | Kept: RS-229 specifies the family in the grouped view and export |
| 28 | ExcelJS loads a dense 8 MB sheet whole (~0.8 GB peak) | Kept: pre-existing in the bid import; prod is Railway, not the 512m compose stack; a streaming reader is a separate change |
| 29 | Market apply can deadlock with a long scraper push on shared rows | Mitigated: the apply now writes in two statements under its sorted locks; the other writers' order is unchanged |
| 30 | Bid import ignores a ¥ mark on a USD order | Kept: pre-existing and deliberate (the order names the currency) |
| 31 | New SPA against the not-yet-deployed backend applies one condition's price to all | Kept: minutes-long deploy skew |
| 32 | `:online` lookups reuse the OpenAI minimal-reasoning tuning | Kept: external behaviour, unverified; RS-230 already says to try the model path on dev before enabling |
| 33 | Cleanups (duplicated price-sheet intake, `aiRevField_*` labels, `ramFamily` re-parsing schemes, `soldFlagSql` mask per caller, `lines_hash` write-only, second-pass re-pays rereads, list subqueries, 5 s polling) | Kept: no behaviour change |
| 34 | (sweep) Archiving a PO left its queued review to run, spend and notify | **Fixed**: archive supersedes it |
| 35 | (sweep) Five failed or superseded runs hid the last finished review's findings (`LIMIT 5`) | **Fixed**: the newest finished review is read on its own |
| 36 | (sweep) Apply remounted Review mode without flushing waiting count ticks | **Fixed**: flushes first, as a drawer edit does |
| 37 | (sweep) The cost cap is per review run, not a running total per PO | Kept: a review after a resubmission is new work, and a Re-run is the manager's own call to spend (RS-230) |

## Acceptance criteria

- [x] A RAM line saved from an auto-corrected scan gets no `pn_label_differs`
      finding suggesting the misread.
- [x] Lots picked in the grouped Inventory view reach a sell order with their
      own part numbers.
- [x] A `sold` written after the migration reads as `done`.
- [x] Apply on a Form finding moves its Device too and settles that finding.
- [x] `ai_review_done` reads as words for managers and is not in a
      purchaser's PO history; Activity drops old `Done → Sold` rows.
- [x] The worker survives a deleted line, honours shutdown, and keeps the cost
      cap under concurrency.
- [x] Kingston DDR3L / kits, SK Hynix VLP and PC4 speeds decode; an
      undecodable part # is not rewritten by a scan.
- [x] Price sheets read the Unit Price column, skip hidden tabs and non-USD
      rows (Market), and read `12,50` as 12.50; a 0 bid is no bid.
- [x] Archiving a PO cancels its waiting review; failed runs don't hide the
      last finished one.

## Out of scope

The kept findings above.

## Notes

- Verified with the full backend suite (223 files, 2331 tests) and the
  frontend suite (756 tests); new tests cover each fixed behaviour, and most
  were written failing first.
- Driven on a local stack (`/verify`): the Market preview of a broker sheet
  (型号 under a title row, `单价（美元）` beside List and Ext. Price, `12,50`,
  a hidden tab, an `RMB` tab); an AI review of a scan-corrected line (no
  finding) and of a SODIMM/Laptop line whose part # is an RDIMM (the one-field
  PATCH 400s, the cascaded one is accepted and both findings resolve);
  `ai_review_done` absent from the purchaser's events and a `note` on
  Activity; a `sold` written by hand reading back `done`.
