// Order-level "other fees" (migration 0080) are a PO-header amount, but every
// profit and commission query in this codebase is line-level. These two
// fragments push the fee down to the line so the existing formulas keep working
// by substituting `ol.unit_cost` -> `effUnitCost(sql)`.
//
// LATERAL rather than a CTE: the weekly-profit chart in routes/dashboard.ts
// already opens with `WITH series AS (…)`, and a CTE fragment can't be pasted
// into an existing WITH list. LATERAL drops into any FROM clause unchanged, and
// Postgres memoizes it per po.id against order_lines' order_id index — where a
// CTE would hash-aggregate the whole table once per query.
//
// Both fragments reference the orders row as `po` and the PO line as `ol`;
// every call site already uses those aliases. Neither binds a parameter — they
// are pure identifiers — so they are safe to interpolate more than once in the
// same query and cannot carry user input.

import type { Sql, TransactionSql } from 'postgres';

type SqlLike = Sql | TransactionSql;

// Allocation basis for one PO. Must appear after the join that introduces `po`.
//
// Weighted by what was bought, not what is left: a partial sale decrements
// `qty` and parks the original in `qty_purchased`, so a basis over `qty` shrank
// with every sale — the fee over-allocated to the units still on the shelf,
// and a Done sale's cost moved retroactively when a sibling line sold later.
// Same rule as the goods-total mirror (services/orderGoodsTotal.ts).
export function poFeeBasis(sql: SqlLike) {
  return sql`
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(fl.qty_purchased, fl.qty) * fl.unit_cost), 0) AS goods,
             COALESCE(SUM(COALESCE(fl.qty_purchased, fl.qty)),                0) AS units
      FROM order_lines fl
      WHERE fl.order_id = po.id
    ) fee ON TRUE
  `;
}

// unit_cost with this line's pro-rata share of the PO's other_fees folded in.
// Cost-weighted, so a line's share is proportional to what it contributed to
// the goods subtotal: fee * (qty*unit_cost) / goods, with qty cancelling once
// expressed per unit.
//
// The `units` branch is not dead code. A free or nominal lot — every unit_cost
// zero, with a real processing fee — has goods = 0 and nothing for a cost
// weighting to divide by. Written multiplicatively as unit_cost * (1 +
// fee/goods) that case needs NULLIF/COALESCE and the fee vanishes from cost
// entirely, silently overpaying commission. Falling back to a flat per-unit
// split keeps the money.
export function effUnitCost(sql: SqlLike) {
  return sql`(ol.unit_cost + CASE
      WHEN COALESCE(fee.goods, 0) > 0 THEN po.other_fees * ol.unit_cost / fee.goods
      WHEN COALESCE(fee.units, 0) > 0 THEN po.other_fees / fee.units
      ELSE 0
    END)`;
}

// What one unit actually cost the company: `effUnitCost` with the negotiated
// lot price standing in for the line sum when the header states one. A lot
// bought for $500 over five $0 lines costs its units $100 each, not the fee
// share alone — which is what `effUnitCost` says, because every projection
// and commission formula is line-level and the lot price is a header figure.
//
// The price is spread the way the fee is (cost-weighted, flat per unit when
// every line is $0), so the two shares can be taken over one header amount.
// With no stated price that amount is goods + fees over goods, which is
// `effUnitCost` exactly. `> 0`, not `IS NOT NULL`: a header pinned at $0 over
// priced lines exists in production, and reading it as the price would zero
// the cost of everything sold from it.
export function paidUnitCost(sql: SqlLike) {
  return sql`(CASE
      WHEN COALESCE(fee.goods, 0) > 0 THEN
        (CASE WHEN po.total_cost > 0 THEN po.total_cost ELSE fee.goods END + po.other_fees)
          * ol.unit_cost / fee.goods
      WHEN COALESCE(fee.units, 0) > 0 THEN
        (CASE WHEN po.total_cost > 0 THEN po.total_cost ELSE 0 END + po.other_fees) / fee.units
      ELSE 0
    END)`;
}

// What one PO's units actually earned, for the realized-profit figure. Must
// appear after the join that introduces the orders row as `o` (the list and
// detail queries both use that alias); each half opens its own `po`/`ol`/`fee`
// scope so the fragments above drop in unchanged.
//
// Two halves that cannot share a row set: the sold side is one row per Done
// sell-order line, priced at what the unit sold for less what it cost; the
// as-bought side one row per PO line — including lines nothing has sold from
// — and is the purchaser's projected commission basis, the same per-line
// margin the dashboard and the spreadsheet show, taken on the PO as bought.
// An unpriced line has no projection and drops out of that SUM the way it
// does everywhere else. `services/poRealized.ts` does the arithmetic.
//
// `on` false joins a stub of NULLs instead: the figure is managers-only, and
// a purchaser's list would otherwise pay for two aggregates per row it never
// sees. The column list stays fixed so the SELECT and GROUP BY don't fork.
export function poRealizedLateral(sql: SqlLike, on: boolean) {
  if (!on) {
    return sql`
      LEFT JOIN LATERAL (
        SELECT NULL::int AS sold_qty, NULL::float AS revenue, NULL::float AS cost,
               NULL::int AS bought_qty, NULL::float AS projected_profit
      ) rz ON TRUE
    `;
  }
  return sql`
    LEFT JOIN LATERAL (
      SELECT sold.sold_qty, sold.revenue, sold.cost,
             bought.bought_qty, bought.projected_profit
      FROM (
        SELECT SUM(sol.qty)::int                                           AS sold_qty,
               SUM(sol.qty * sol.unit_price)::float                        AS revenue,
               SUM(sol.qty * ${paidUnitCost(sql)})::float                  AS cost
        FROM orders po
        JOIN order_lines ol      ON ol.order_id = po.id
        JOIN sell_order_lines sol ON sol.inventory_id = ol.id
        JOIN sell_orders so       ON so.id = sol.sell_order_id
        ${poFeeBasis(sql)}
        WHERE po.id = o.id AND so.status = 'Done'
      ) sold,
      (
        SELECT SUM(COALESCE(ol.qty_purchased, ol.qty))::int                              AS bought_qty,
               SUM((ol.sell_price - ${effUnitCost(sql)})
                   * COALESCE(ol.qty_purchased, ol.qty))::float                          AS projected_profit
        FROM orders po
        JOIN order_lines ol ON ol.order_id = po.id
        ${poFeeBasis(sql)}
        WHERE po.id = o.id
      ) bought
    ) rz ON TRUE
  `;
}
