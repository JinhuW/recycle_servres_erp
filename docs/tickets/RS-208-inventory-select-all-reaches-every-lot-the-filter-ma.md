---
id: RS-208
title: Inventory select all reaches every lot the filter matches
type: bug
status: done
priority: P2
created: 2026-10-08
reporter: jinhu
branch: fix/inventory-select-all-filter
pr: "#561"
version: 1.230.2
related: []
---

## Ask

> The inventory page when i click the select all buttom. it can only select the current page instead all of aplied item under the filter.

## Context

The desktop Inventory page lists product groups from
`GET /api/inventory/products`, which returns at most 200 groups (`GROUP_CAP`),
the newest first. The header checkbox and the selection bar's
**Select all (n)** built their id list from those 200 loaded groups
(`filterSellableIds` in `DesktopInventory.tsx`). Any filter matching more than
200 products therefore selected only part of what it matched, and the page has
no visible paging, so it reads as "only the current page".

On prod (2026-10-08), the default view holds 1125 lots in **749** product
groups, 1044 of them sellable. RAM alone is 631 groups. The "All warehouses"
pill already counted 749 while the table showed 200.

Selecting that many lots also exposed the export. `runExport` put every
selected id in the GET query string. About 1000 uuids is a ~38 KB URL, past
Node's 16 KB header limit, and the server truncated ids at 1000 regardless.

## Acceptance criteria

- [x] `GET /api/inventory/products` returns `sellable_ids` to managers: every
      Reviewing/Done lot of every group the filters match, past the 200-group
      cap, narrowed per lot to the warehouse filter. Purchasers don't receive
      the field.
- [x] `POST /api/inventory/rows { ids }` returns flat-list rows for those ids,
      manager-only (403), with a 400 on non-uuid input and a 413 past the cap.
- [x] Select all (header checkbox and the bar's button) selects every lot in
      `sellable_ids`, fetching rows the page hasn't loaded. The bar's line count,
      units and revenue include them, and Create sell order, Transfer and
      Add to sell order receive them.
- [x] The **Select all (n)** label and the checkbox state count the full
      matched set.
- [x] Export with a selection sends the ids in a POST body. `GET ?ids=` still
      works for older bundles. More than the cap gets a 413 instead of a silent
      truncation.

## Out of scope

- Showing more than 200 product groups on screen. Uncapped, "All" would be
  about 1.1 MB per filter change.
- `RAW_CAP` (the 2000 newest lines) still bounds the list, the facets and
  select-all alike. Prod has 1125 such lines.
- Attribute chips keep matching at group level ("any lot in the product
  matches"), and only the warehouse filter narrows per lot. Select all keeps
  that behaviour: a lot in a mixed-spec group that doesn't itself match a chip
  is still selected, as it was before.

## Notes

- Plan: `~/.claude/plans/fizzy-zooming-blanket.md`. A reviewer swapped a
  re-deriving GET endpoint for a by-ids POST, so the client keeps one id set
  and the checkbox can't drift from what was selected.
- Verified on a local stack pushed past the cap (a 210-line PO, 304 products):
  select-all took 278 lots against the old 200. Export posted, and its
  workbook held all 278. The sell-order draft listed 278 lines. RAM + LA1 gave
  218, matching both the API and a direct SQL count.
