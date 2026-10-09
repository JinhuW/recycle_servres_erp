---
id: RS-213
title: A PO row is a product, and its # is a stable id on POs and sell orders
type: story
status: in-progress
priority: P2
created: 2026-10-09
reporter: jinhu
branch: feat/po-product-no
pr:
version:
related: [RS-145, RS-184, RS-188, RS-193, RS-206, RS-212]
---

## Ask

> Let we better naming the terminology. The line in the PO can be called products.
> The # in PO is more like an unique id while PO created. Once create it don't chanage.
> Same as sell order, we will use the # (id) to count the PO or SO
> ultrathink review my entire code base and think of any of the logic and workflow need to be update.

> fan out agents to go through my entire code base. Make sure you checked every line of code.

Asked four questions after the sweep; he picked:

- **A partial transfer that splits a PO product** keeps its source's `#`.
  Both rows read `#3`; the PO still counts the same products.
- **A sell-order `#` freezes at creation.** Every later add, Draft included,
  takes the next `#`.
- **A sell-order `#` stays one per product.** Lots of one product share it.
- **Inventory's grouped view keeps "Product"** for a part across POs.

## Context

Neither `#` was stored.

- **PO.** The `#` was a live rank: `lib/poLineNo.ts`, COUNT of siblings by
  `(position, created_at, id)`, and every client counted `i + 1`. Removing a
  product renumbered every product after it. So did a partial transfer, whose
  clone ranked right after its source; a received clone shifted the PO's tail
  for good, and every sell order's "From PO-x #n" with it.
- **Sell order.** The `#` was derived on every read by `numberSheetLines`
  (`routes/sellOrders.ts`) from the packing-list sort, per warehouse tab and
  live part|label|condition. A Draft add, a lot delete, a transfer, a spec
  edit, a warehouse rename or a PO archive renumbered it. `append_batch`
  (RS-206) and the "set it to 0, don't remove it" rules (RS-184, RS-188)
  only softened that.
- **Wording.** It was half-renamed: some English PO screens said "Products",
  most PO, sell-order and Pack-mode screens said line or item, and Chinese
  used about ten words (明细, 行, 项, 项目, 产品, 商品…).

A sweep read all 958 files (158k lines) with 28 parallel readers before the
plan. Plan: `~/.claude/plans/precious-doodling-haven.md`.

## Acceptance criteria

PR 1, PO:
- [ ] Every PO product carries a stored `#` (`order_lines.product_no`). Existing
      rows keep the number they showed before (the migration checks this
      against the old rank and refuses to apply otherwise).
- [ ] A new product takes the PO's next `#`; a removed one leaves a gap; no `#`
      is reused.
- [ ] A partial-transfer split keeps its source's `#`; a discard leaves no gap.
- [ ] The PO page (desktop and phone), Review mode, the PO list drawer, the
      capture page, the sell-order "From PO-x #n" and inventory all show the
      stored `#`, and an unsaved product shows *new*.
- [ ] "N products" on a PO counts distinct `#`s.

PR 2, sell order:
- [ ] Every sell-order product carries a stored `#`. Orders that existed before
      keep the `#`s they showed.
- [ ] A new order numbers its products once, in packing-list order; any later
      add, in any status, takes the next `#`. A new lot of a product already
      on the order joins its `#`.
- [ ] A remove, spec edit, transfer, warehouse change or PO archive moves no `#`.
- [ ] "N products" on a sell order counts distinct `#`s.

PR 3, wording:
- [ ] PO and sell-order rows read "product" / 产品 everywhere a person sees them,
      and the product `#` reads `#n` / 产品 #n.
- [ ] `docs/FEATURES.md` opens with a glossary.

## Out of scope

- The vendor bid sheet: its headers and its per-tab `#` are an import format.
- Wire names (`lines`, `addLines`, `lineCount`, `sourceLineNo`, `po_line_no`,
  event kinds, prefs): labels change, the API does not.
- The `qty = 0` rules stay; only their "so the # doesn't move" reason goes.
- Turning the sell-order PATCH into an id diff (follow-up).

## Notes

- Allocation is one `BEFORE INSERT` trigger on `order_lines` that fills a NULL
  `product_no` from `orders.next_product_no`. Every insert path but the
  transfer clone (which passes its source's `#`) already holds or just created
  the orders row, so it adds no lock in a lines-first path.
