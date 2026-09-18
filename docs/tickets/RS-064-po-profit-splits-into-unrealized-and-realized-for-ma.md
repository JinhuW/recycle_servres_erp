---
id: RS-064
title: PO profit splits into Unrealized and Realized for managers
type: story
status: in-progress
priority: P2
created: 2026-09-17
reporter: jinhu
branch: feat/po-realized-profit
pr:
version:
related: [RS-060, RS-051, RS-062, RS-063]
---

## Ask

> for all PO, i would like to have two type of profit. Realized Profit vs Unrealized Profit.
>
> The sell price manager filled is unRealized Profit and the final sell price counted is  Realized Profit.
>
> The unRealized Profit is the current fomula.  The Reali Realized Profitzed Profit is (final sell price - cost) * count - commission fee
> The   Realized Profit is manager only.
> /frontend-design:frontend-design refine the current ui ux to show them propably.

Asked on the plan which commission the realized figure subtracts, with a
worked example (8 units, projected $150, cost $100, 10%, 6 sold at $140):

> Commission actually paid

and whether Unrealized should also subtract commission:

> For the purchaser view, keep the original view. For the manager add a new
> view for realize profit.

## Context

A PO's profit has always been a projection: `(Sell / Unit − unit cost) × qty
− other fees`, from the sell price a manager fills in per line. It feeds the
purchaser's commission and says nothing about what the units sold for.
RS-060 (v1.147.0) surfaced the per-line final sell price from Done sell
orders, but no PO-level figure used it: the list's `profit`, the edit page's
cost tape and the phone money card all still showed the projection only.

Two figures now exist per PO, and the projection keeps its name in the
purchaser's view:

- **Unrealized** — the existing formula, unchanged everywhere it appears.
- **Realized** — over the Done sell-order lines naming the PO's lines,
  `Σ (unit_price − effective unit cost) × qty`, minus the commission the
  company pays the purchaser: `max(0, projected revenue − goods − other fees)
  × rate`, on the PO as bought (`COALESCE(qty_purchased, qty)`), because that
  is the commission actually paid, not one recomputed on the realized margin.
  Clamped at zero: a negative commission would inflate the figure. Null until
  something sells — a PO with nothing sold shows "—", not `−commission`.

The fee basis in `lib/po-cost.ts` (`poFeeBasis`) weighted by the line's
current `qty`, which a partial sale decrements, so the fee over-allocated
after one and a Done sale's cost changed retroactively when a sibling line
later sold partially. It now weights by the as-bought quantity, the same
basis the goods-total mirror uses. That also corrects the drift in the
dashboard, profile and members "realized" figures for partially sold POs.

The desktop Purchase orders page lost its KPI strip in RS-062 (v1.147.2),
at Jinhu's request, so no Realized tile is added there; the list carries
the figure as a column.

## Acceptance criteria

- [ ] `GET /api/orders` and `GET /api/orders/:id` return `realized`
      (`soldQty`, `boughtQty`, `revenue`, `cost`, `grossProfit`,
      `commission`, `profit`) on every PO for a manager; `null` when nothing
      has sold, and `null` for a purchaser (including the PO's owner) and for
      a manager previewing as purchaser.
- [ ] Draft, Shipped, Awaiting payment and Closed sell orders do not count.
- [ ] Cost of sold units amortizes other fees on the as-bought basis, so a
      later partial sale on a sibling line leaves an earlier sale's cost
      unchanged and a fully sold PO allocates exactly its fees.
- [ ] Desktop PO list: when the Profit column is on, managers see an
      Unrealized and a Realized column; purchasers keep a single Profit
      column. Realized reads "—" until something sells and shows `n/N sold`
      under a partial figure.
- [ ] Desktop PO edit page: the cost tape gains a manager-only "Realized ·
      from completed sell orders" block — sold meter, revenue, cost of sold
      units, gross profit, commission paid, realized profit — or a "Nothing
      sold yet" row. The projected block is unchanged.
- [ ] Phone PO detail: the money card gains a manager-only Unrealized /
      Realized pair with the sold meter. Phone PO list: a "Realized" line
      under the revenue for managers when it exists.
- [ ] Purchaser views are unchanged apart from the projected-profit row on
      the desktop tape now being coloured (it carried the class but no rule).

## Out of scope

- Per-line realized profit (the Final sell price column is the per-line
  view), the PO spreadsheet export, the dashboard.
- Reconciling the three projections of commission (list column, Payment
  detail card, this tape row) on partially sold or negotiated-lot POs; each
  keeps its own basis.
- Recovering the KPI strip removed in RS-062.

## Notes

- Plan: `~/.claude/plans/eventual-wobbling-puffin.md`.
- No migration; the RS-060 indexes cover the lateral.
