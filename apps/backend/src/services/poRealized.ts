// A PO's realized profit: what its units earned on Done sell orders, net of
// the commission the company pays the purchaser. The columns come from
// `poRealizedLateral` (lib/po-cost.ts); this is the only place the arithmetic
// lives, so the list and the detail endpoint cannot drift apart.
//
// The commission is the one actually paid — the purchaser's projected
// commission on the whole PO as bought — not one recomputed on the realized
// margin. A partly sold PO therefore reads low until the rest sells; that is
// the figure the business asked for. It is taken on `qty_purchased` where a
// partial sale set it, because today's `qty` no longer says what the PO was
// paid on, and clamped at zero: a lot priced below cost pays no commission,
// and a negative one would inflate the profit it is netted from.

export type PoRealized = {
  soldQty: number;
  boughtQty: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  commission: number;
  profit: number;
};

export type PoRealizedRow = {
  sold_qty: number | null;
  bought_qty: number | null;
  revenue: number | null;
  cost: number | null;
  projected_revenue: number | null;
  goods_bought: number | null;
};

export type PoRealizedHeader = {
  total_cost: number | null;
  other_fees: number | null;
  commission_rate: number | null;
};

const cents = (v: number) => Math.round(v * 100) / 100;

// Null until something has sold: a PO with no Done sale has no realized
// figure, not a negative one the size of its commission.
export function realizedFromRow(row: PoRealizedRow, po: PoRealizedHeader): PoRealized | null {
  const soldQty = row.sold_qty ?? 0;
  if (soldQty <= 0) return null;
  const revenue = row.revenue ?? 0;
  const cost = row.cost ?? 0;
  const goods = po.total_cost ?? row.goods_bought ?? 0;
  const fees = po.other_fees ?? 0;
  const projectedProfit = (row.projected_revenue ?? 0) - goods - fees;
  const commission = Math.max(0, projectedProfit) * (po.commission_rate ?? 0);
  const grossProfit = revenue - cost;
  return {
    soldQty,
    boughtQty: row.bought_qty ?? 0,
    revenue: cents(revenue),
    cost: cents(cost),
    grossProfit: cents(grossProfit),
    commission: cents(commission),
    profit: cents(grossProfit - commission),
  };
}
