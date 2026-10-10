---
id: RS-225
title: Inventory search finds a PO product by its #, and its PO link lands on that product
type: story
status: done
priority: P2
created: 2026-10-10
reporter: jinhu
branch: feat/search-product-no
pr: 596
version: 1.240.0
related: []
---

## Ask

> for the search here. I hope it can also search the # of the product in the PO.
>
> for example. #30. It will show all product which id is #30.

> when i click the link, It should jump the specific locations.

(The second message came with a screenshot of an inventory lot row reading
`PO-1483 #22`.)

## Context

Every product on a PO has a stored `#` (`order_lines.product_no`, v1.234.0),
and the inventory lots table prints it next to the PO link (`PO-1483 #22`,
v1.232.0). The inventory search (`lineSearchFrag` in
`routes/inventory.ts`) matched part number, serial, brand, description, item
type and PO id, but not the `#`, and the PO link opened the PO at the top, so a
30-product PO had to be scrolled by eye to find #22.

## Acceptance criteria

- [x] Typing `#30` in the inventory search lists every lot whose product `#`
      on its PO is 30, in the flat list, the grouped view and the export.
- [x] The match is exact: `#3` does not bring back #30 or #300.
- [x] `PO-1483 #22`, the way the lots table prints it, narrows to that one
      product.
- [x] The PO link on an inventory lot, and on a sell-order line's "from PO"
      text, opens the PO scrolled to that product's row, which is flagged for
      a few seconds.

## Out of scope

- The phone PO screen: the screenshot and the links are desktop; the phone
  inventory list has no per-lot PO link.
- Opening the product's drawer on landing — the row is shown, not edited.

## Notes

- The link carries the `#` as `?line=N` in the hash query, so the router still
  matches the PO and a copied link lands on the same row. A partial transfer's
  clone shares its source's `#`; the first row with it is the one landed on.
