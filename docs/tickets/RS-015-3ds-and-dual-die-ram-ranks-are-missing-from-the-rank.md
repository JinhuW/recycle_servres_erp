---
id: RS-015
title: 3DS and dual-die RAM ranks are missing from the Rank dropdown
type: story
status: in-review
priority: P3
created: 2026-09-03
reporter: Jinhu
branch: session/20260903-100736
pr: https://github.com/JinhuW/recycle_servres_erp/pull/248
version: 1.120.0
related: []
---

## Ask

> some ram rank is missing, pls double check and add to the system

## Context

The Rank dropdown on RAM lines is fed by the `RAM_RANK` group of
`catalog_options`, served through `/api/lookups`.  It holds 13 values in
production — the plain JEDEC `NRxM` grid (`1Rx4` … `8Rx8`) — and nothing else.

High-density RDIMM/LRDIMM labels carry two notations the catalog has none of:

- `nDRxm` — `D` is a dual-die package (DDP), e.g. `4DRx4`
- `nSmRxk` — `S` is an n-high 3DS stack, e.g. `2S2Rx4`

Those are different constructions, not two vendors' spellings of one thing;
Samsung, SK Hynix and Micron each print both depending on the module.

Checking the rank values actually stored in production against the catalog
turned up exactly one in use that the dropdown does not offer: `4DRx4`, on three
`order_lines`.  Nothing was corrupted by that — `CatSelect` renders an
off-catalog stored value as a one-off option, so the rows still display — but
the value could only ever have been typed in by another route, never picked.

Two mechanisms kept the gap quiet rather than loud:

- `lib/scanValidation.ts` strips a scanned value that isn't in the catalog, so an
  OCR read of `4DRx4` disappears from the prefilled form.  That is the right
  behaviour on its own (a `<select>` holding an unknown value renders blank), but
  it makes a catalog gap look like "the AI didn't read the rank".
- `ai/prompts.ts` hands the OCR model the 13 values as a closed enum, so the
  model is instructed not to return the real marking in the first place.

Which members of the two families to add was narrowed with Jinhu to the ones that
could be tied to real labels.  `2DRx4`, `2DRx8`, `4DRx8` and `8S2Rx4` were
proposed and dropped — `8S2Rx4` is a JEDEC-defined configuration that appears
never to have shipped.

## Acceptance criteria

- [ ] The Rank dropdown offers 18 values: the existing 13, plus `4DRx4`,
      `8DRx4`, `2S2Rx4`, `2S4Rx4`, `4S2Rx4`, with the new block after `8Rx8`.
- [ ] The same 18 appear on desktop Submit, the mobile shell, and Inventory edit.
- [ ] The list is identical whether a database was built by migration alone or by
      `db:seed` (the seed deletes and rewrites `catalog_options`, so the two
      lists have to agree).
- [ ] A label scan that reads `4DRX4` or `2S2RX4` normalises to the catalog
      spelling and survives into the prefilled line instead of being stripped.
- [ ] The OCR prompt permits the new markings.
- [ ] The three existing `4DRx4` rows are untouched — they already use the exact
      spelling being added.

## Out of scope

- Server-side validation of rank.  `order_lines.rank` is plain TEXT with no
  CHECK and the routes write it straight through; the vocabulary is enforced only
  by the client `<select>`.  Making rank a validated field is a separate and
  larger change.
- Turning Rank into a free-text combobox (as drive capacity and brand are).
  Considered and rejected: keeping it a strict dropdown keeps pricing and
  matching on clean values.

## Notes

Plan review corrected the framing this ticket was drafted with: `D` and `S` are
two constructions, not a Samsung-vs-Micron spelling difference.  It also
established that a test can only guard the seed half of the list — the test
template database is built migrate-then-seed, and the seed wipes the table
first — so the migration's own content needs a manual migrate-only check.
