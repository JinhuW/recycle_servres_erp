// Who drove the dashboard's three money figures in the window: cost by
// supplier / purchaser / category, sales and profit by customer / purchaser /
// category. Every figure here is the same figure the tiles and the leaderboard
// show, grouped one more way — spend is the PO header total the leaderboard
// ranks by, sales and profit are the revenue and gross-profit tiles' rows —
// so a card's total equals the tile above it and its tabs equal each other.
//
// The purchaser lens groups the caller's own projected figures instead, by
// supplier and category only: the peer-money mask (PRD §6.8) rules out a
// purchaser dimension, and the sale side is not theirs to see.

import type postgres from 'postgres';
import type { Sql, TransactionSql } from 'postgres';
import { effUnitCost, poFeeBasis } from '../lib/po-cost';
import type { Role } from '../types';

type SqlLike = Sql | TransactionSql;
type Frag = postgres.Fragment;

export type ContribRow = { id: string | null; name: string | null; amount: number; count: number };
export type ContribRows = {
  rows: ContribRow[];
  others: { n: number; amount: number } | null;
};
export type ContribMetric = 'cost' | 'revenue' | 'profit';
export type ContribDim = 'supplier' | 'purchaser' | 'customer' | 'category';
export type Contributions = Record<ContribMetric, {
  total: number;
  count: number;
  byDim: Partial<Record<ContribDim, ContribRows>>;
}>;

// Mercury's tables show this many before "remaining"; past it the bars are
// too short to read and the tail belongs in one row.
const TOP_N = 7;

const r2dp = (v: number) => Math.round(v * 100) / 100;

type Grouping = {
  key: Frag;
  name: Frag;
  amount: Frag;
  count: Frag;
  from: Frag;
  where: Frag;
};

async function grouped(sql: SqlLike, g: Grouping): Promise<ContribRow[]> {
  const rows = await sql<{ id: string | null; name: string | null; amount: number; count: number }[]>`
    SELECT ${g.key} AS id, ${g.name} AS name,
           COALESCE(SUM(${g.amount}), 0)::float AS amount,
           ${g.count}::int AS count
    FROM ${g.from}
    WHERE ${g.where}
    GROUP BY 1, 2
    ORDER BY amount DESC, name NULLS LAST
  `;
  return rows.map(r => ({ id: r.id, name: r.name, amount: r2dp(r.amount), count: r.count }));
}

function fold(rows: ContribRow[]): ContribRows & { total: number } {
  const total = r2dp(rows.reduce((s, r) => s + r.amount, 0));
  const head = rows.slice(0, TOP_N);
  const tail = rows.slice(TOP_N);
  const others = tail.length
    ? { n: tail.length, amount: r2dp(tail.reduce((s, r) => s + r.amount, 0)) }
    : null;
  return { rows: head, others, total };
}

export async function contributions(
  sql: SqlLike,
  opts: { role: Role; userId: string; start: Frag; end: Frag },
): Promise<Contributions> {
  const { start, end } = opts;
  const feeBasis = poFeeBasis(sql);
  const eff = effUnitCost(sql);
  const headerCost = sql`COALESCE(po.total_cost, fee.goods) + po.other_fees`;
  const reviewed = sql`po.lifecycle IN ('ready_to_pay', 'done')
                       AND po.created_at >= ${start} AND po.created_at < ${end}`;

  if (opts.role === 'manager') {
    const saleWin = sql`so.status = 'Done' AND so.updated_at >= ${start} AND so.updated_at < ${end}`;
    const salesFrom = sql`
      sell_order_lines sol
      JOIN sell_orders so ON so.id = sol.sell_order_id
      JOIN order_lines ol ON ol.id = sol.inventory_id
      JOIN orders po      ON po.id = ol.order_id
      ${feeBasis}`;
    const revenue = sql`sol.unit_price * sol.qty`;
    const profit  = sql`(sol.unit_price - ${eff}) * sol.qty`;
    const soCount = sql`COUNT(DISTINCT so.id)`;
    const saleDims = (amount: Frag): Record<'customer' | 'purchaser' | 'category', Grouping> => ({
      customer:  { key: sql`so.customer_id`, name: sql`cu.name`, amount, count: soCount, where: saleWin,
                   from: sql`${salesFrom} JOIN customers cu ON cu.id = so.customer_id` },
      purchaser: { key: sql`po.user_id`, name: sql`u.name`, amount, count: soCount, where: saleWin,
                   from: sql`${salesFrom} JOIN users u ON u.id = po.user_id` },
      category:  { key: sql`sol.category`, name: sql`sol.category`, amount, count: soCount, where: saleWin,
                   from: salesFrom },
    });
    const spendFrom = sql`orders po ${feeBasis}`;
    const poCount = sql`COUNT(DISTINCT po.id)`;
    const costDims: Record<'supplier' | 'purchaser' | 'category', Grouping> = {
      supplier:  { key: sql`po.supplier_id`, name: sql`s.name`, amount: headerCost, count: poCount, where: reviewed,
                   from: sql`${spendFrom} LEFT JOIN suppliers s ON s.id = po.supplier_id` },
      purchaser: { key: sql`po.user_id`, name: sql`u.name`, amount: headerCost, count: poCount, where: reviewed,
                   from: sql`${spendFrom} JOIN users u ON u.id = po.user_id` },
      category:  { key: sql`po.category`, name: sql`po.category`, amount: headerCost, count: poCount, where: reviewed,
                   from: spendFrom },
    };
    const rev = saleDims(revenue);
    const prof = saleDims(profit);
    const [cS, cP, cC, rCu, rP, rC, pCu, pP, pC, poN, soN] = await Promise.all([
      grouped(sql, costDims.supplier), grouped(sql, costDims.purchaser), grouped(sql, costDims.category),
      grouped(sql, rev.customer), grouped(sql, rev.purchaser), grouped(sql, rev.category),
      grouped(sql, prof.customer), grouped(sql, prof.purchaser), grouped(sql, prof.category),
      sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM orders po WHERE ${reviewed}`,
      sql<{ n: number }[]>`SELECT COUNT(DISTINCT so.id)::int AS n FROM ${salesFrom} WHERE ${saleWin}`,
    ]);
    return {
      cost:    shape(poN[0].n, { supplier: cS, purchaser: cP, category: cC }),
      revenue: shape(soN[0].n, { customer: rCu, purchaser: rP, category: rC }),
      profit:  shape(soN[0].n, { customer: pCu, purchaser: pP, category: pC }),
    };
  }

  // Purchaser lens — the caller's own reviewed POs. Revenue and profit are the
  // projected line figures; cost is the header figure, so its category is the
  // header's (a mixed PO is "Mixed") while the line figures split by line.
  const own = sql`${reviewed} AND po.user_id = ${opts.userId}`;
  const poCount = sql`COUNT(DISTINCT po.id)`;
  const linesFrom = sql`order_lines ol JOIN orders po ON po.id = ol.order_id ${feeBasis}`;
  const spendFrom = sql`orders po ${feeBasis}`;
  const revenue = sql`ol.sell_price * ol.qty`;
  const profit  = sql`(ol.sell_price - ${eff}) * ol.qty`;
  const lineDims = (amount: Frag): Record<'supplier' | 'category', Grouping> => ({
    supplier: { key: sql`po.supplier_id`, name: sql`s.name`, amount, count: poCount, where: own,
                from: sql`${linesFrom} LEFT JOIN suppliers s ON s.id = po.supplier_id` },
    category: { key: sql`ol.category`, name: sql`ol.category`, amount, count: poCount, where: own,
                from: linesFrom },
  });
  const costDims: Record<'supplier' | 'category', Grouping> = {
    supplier: { key: sql`po.supplier_id`, name: sql`s.name`, amount: headerCost, count: poCount, where: own,
                from: sql`${spendFrom} LEFT JOIN suppliers s ON s.id = po.supplier_id` },
    category: { key: sql`po.category`, name: sql`po.category`, amount: headerCost, count: poCount, where: own,
                from: spendFrom },
  };
  const rev = lineDims(revenue);
  const prof = lineDims(profit);
  const [cS, cC, rS, rC, pS, pC, poN] = await Promise.all([
    grouped(sql, costDims.supplier), grouped(sql, costDims.category),
    grouped(sql, rev.supplier), grouped(sql, rev.category),
    grouped(sql, prof.supplier), grouped(sql, prof.category),
    sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM orders po WHERE ${own}`,
  ]);
  return {
    cost:    shape(poN[0].n, { supplier: cS, category: cC }),
    revenue: shape(poN[0].n, { supplier: rS, category: rC }),
    profit:  shape(poN[0].n, { supplier: pS, category: pC }),
  };
}

// The first dimension's total is every dimension's total — they group the
// same rows — so it is stated once at the metric level.
function shape(count: number, dims: Partial<Record<ContribDim, ContribRow[]>>) {
  const byDim: Partial<Record<ContribDim, ContribRows>> = {};
  let total = 0;
  let first = true;
  for (const [dim, rows] of Object.entries(dims) as [ContribDim, ContribRow[]][]) {
    const folded = fold(rows);
    if (first) { total = folded.total; first = false; }
    byDim[dim] = { rows: folded.rows, others: folded.others };
  }
  return { total, count, byDim };
}
