---
id: RS-387
title: Sort the Inventory table by column
type: story
status: done
priority: P2
created: 2026-10-24
reporter: jinhu
branch: JinhuW/wahoo
pr: 864
version: 1.332.0
related: [RS-004, RS-285]
---

## Ask

> Enable the inventory table can be sort:
> [Image #1]

(The image is the header row of the desktop Inventory table: Product, Part #,
Qty, Lots, Warehouses, Cost, Sell.)

Then, while it was being built:

> keep in mind the page may only part loaded. Make sure it sort by all data
> instead of the current page.

## Context

The desktop Inventory page is one grouped product table,
`apps/frontend/src/pages/desktop/InventoryProductTable.tsx`, and its headers
were plain `<th>`. `GET /api/inventory/products` sends the rows already in the
vendor bid-sheet order (category → brand → capacity → speed, RS-004's
`sortSheetRows`), and that was the only order the page had. There was no way
to put the biggest stock, the priciest product or one warehouse's goods at the
top.

The endpoint lists at most 200 products (`GROUP_CAP`), the newest ones, out
of a working set of up to 5,000 lines. A sort inside the browser would only
reorder those 200, which is what the follow-up rules out. So the server sorts:
`?sort=<column>&dir=asc|desc` ranks every product the filters match, then
caps. The comparator lives in `packages/shared` (`inventoryGroupSort.ts`), so
the table can re-sort the rows it already holds the moment a header is
clicked, and agrees with what the server sends back.

Orders and the Fleet workers table (RS-285) sort through the shared
`components/SortTh.tsx` header; this reuses it with Fleet's cycle, whose third
click goes back to the server's own order. Here that order is the bid sheet,
so it has to stay reachable.

## Acceptance criteria

- [x] Clicking Product / Part # / Qty / Lots / Warehouses / Cost / Sell sorts
      the product rows; the header shows `SortTh`'s caret and `aria-sort`.
- [x] The sort ranks every product the filters match, not only the 200 the
      page lists: a product past the cap comes to the top when its column
      puts it there.
- [x] A click cycles desc → asc → back to the bid-sheet order the server sends.
- [x] Blanks (no part number, no warehouse, no sell price) sort last in both
      directions.
- [x] Ties keep the bid-sheet order.
- [x] Product sorts by the name the row shows, numbers collated naturally
      (16GB before 128GB).
- [x] The sort survives leaving the page and coming back.
- [x] An expanded product stays open, and selection stays put, when the rows
      reorder.
- [x] Sorting by a column the Columns menu hides falls back to the bid-sheet
      order. A purchaser's cost sort leaves the list unranked, since their
      products carry no cost.
- [x] An unknown `sort` or `dir` is a 400.

## Out of scope

- The export, which keeps the bid-sheet order (RS-004).
- The lots table inside an expanded product.
- The phone Inventory list.

## Notes

- Plan: `~/.claude/plans/parsed-scribbling-lampson.md`. It planned a
  client-side sort; the follow-up moved it to the server.
- The unsorted path still builds only the newest 200 products. Only a sort
  builds every matching one, so the default load costs what it did.
- Lots ties break on PO count.
- Local e2e (Playwright, manager): Qty desc → asc → reset, Sell desc with
  blanks last, an expanded product following its row under a Product sort,
  the sort kept across Orders and back, and hiding Sell while sorted by it.
  The dev DB holds 92 products, under the cap. The past-cap case is
  `inventory-products.test.ts` → *sorts every matching product before the
  cap*.
