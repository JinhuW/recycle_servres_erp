import type postgres from 'postgres';
import type { SqlLike } from '../db';

// A sell order holds its inventory only once it leaves Draft or Packing. Those
// orders are proposals — several may name the same line and only the one that
// ships wins, so the claim is staked when the order is promoted, not when it is
// written or boxed.
// Done is absent because it already consumed the stock (order_lines.qty is
// decremented and sold-out lines flip to 'Sold'); Closed is absent because it
// released it.
//
// A commitment reserves the QUANTITY its line names, never the whole lot: 20
// units of a 100-piece line leave 80 sellable to the next order. Every "how
// much of this line is spoken for?" query must sum sol.qty over this list —
// the rule used to be hand-rolled at five call sites and all five had drifted
// apart, and an EXISTS test here silently blocks the untouched remainder.
const COMMITTED_SELL_STATUSES = ['Shipped', 'Awaiting payment'] as const;

// postgres.js binds a readonly tuple as a record, not an array — the spread is
// what makes `= ANY(${committedSellStatuses()}::text[])` a text[] parameter.
export function committedSellStatuses(): string[] {
  return [...COMMITTED_SELL_STATUSES];
}

// The proposals: Draft, and Packing — a Draft whose goods are being boxed.
// Neither reserves anything; leaving either for a committed status or Done is
// where the order is validated against the stock, and where Pack mode stops
// writing its counts onto the lines.
const PROPOSAL_SELL_STATUSES = ['Draft', 'Packing'] as const;

export function proposalSellStatuses(): string[] {
  return [...PROPOSAL_SELL_STATUSES];
}

// Every status in which a sell order still *names* its lines — the proposals
// included. A proposal reserves nothing (above), but a line it names cannot
// vanish either: it is re-validated on promotion and would fail then. Use this
// where the question is "is anyone still pointing at this line", the committed
// set where it is "how much of it is spoken for".
const OPEN_SELL_STATUSES = [...PROPOSAL_SELL_STATUSES, ...COMMITTED_SELL_STATUSES] as const;

export function openSellStatuses(): string[] {
  return [...OPEN_SELL_STATUSES];
}

// The line statuses a sell order may hold — what validateSellLines accepts.
// Also the boundary at which a Draft stops caring about a PO stage move: a
// cascade that lands lines inside this set leaves every draft promotable, so
// only committed orders may refuse it; one that lands outside (Draft, In
// Transit) would strand a draft at promotion, so there a Draft refuses too.
const SELLABLE_LINE_STATUSES = ['Reviewing', 'Done'] as const;

export function isSellableLineStatus(status: string): boolean {
  return (SELLABLE_LINE_STATUSES as readonly string[]).includes(status);
}

type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

/**
 * Units of a line held by sell orders in `statuses` (committed by default) —
 * as a scalar SQL expression, for a SELECT list, a WHERE or an ORDER BY.
 * `lineId` is the column naming the line in the outer query (`sql\`l.id\``).
 * `excludeOrderId` leaves one order out: the one being edited, whose own claim
 * is not competition. The inner aliases are deliberately odd so they can never
 * shadow an outer `sol`/`so` the caller correlates on.
 */
export function committedQtySql(
  sql: SqlLike,
  lineId: SqlFragment,
  opts: { statuses?: string[]; excludeOrderId?: string | null } = {},
): SqlFragment {
  const statuses = opts.statuses ?? committedSellStatuses();
  const exclude = opts.excludeOrderId ?? null;
  return sql`(SELECT COALESCE(SUM(c_sol.qty), 0)::int
      FROM sell_order_lines c_sol
      JOIN sell_orders c_so ON c_so.id = c_sol.sell_order_id
     WHERE c_sol.inventory_id = ${lineId}
       AND c_so.status = ANY(${statuses}::text[])
       AND (${exclude}::text IS NULL OR c_so.id <> ${exclude}::text))`;
}

export type LineClaim = {
  qty: number;
  // One committed order to name in a refusal: "not enough left" with no order
  // to go and look at leaves the manager stuck.
  sellOrderId: string;
  label: string | null;
  partNumber: string | null;
};

/**
 * Committed claims per line, keyed by lower-cased line id; a line nothing
 * commits is absent. Same rule as committedQtySql, for code that holds a list
 * of ids rather than a query to fold the expression into.
 */
export async function committedClaimsByLine(
  sql: SqlLike,
  lineIds: readonly string[],
  opts: { excludeOrderId?: string | null } = {},
): Promise<Map<string, LineClaim>> {
  if (lineIds.length === 0) return new Map();
  const exclude = opts.excludeOrderId ?? null;
  const rows = await sql<{
    id: string; qty: number; so_id: string; label: string | null; part_number: string | null;
  }[]>`
    SELECT sol.inventory_id AS id, SUM(sol.qty)::int AS qty, MIN(so.id) AS so_id,
           MIN(sol.label) AS label, MIN(sol.part_number) AS part_number
    FROM sell_order_lines sol
    JOIN sell_orders so ON so.id = sol.sell_order_id
    WHERE sol.inventory_id = ANY(${[...lineIds]}::uuid[])
      AND so.status = ANY(${committedSellStatuses()}::text[])
      AND (${exclude}::text IS NULL OR so.id <> ${exclude}::text)
      -- A line held at 0 claims nothing, so it never names the order holding it.
      AND sol.qty > 0
    GROUP BY sol.inventory_id
  `;
  return new Map(rows.map((r) => [r.id.toLowerCase(), {
    qty: r.qty, sellOrderId: r.so_id, label: r.label, partNumber: r.part_number,
  }]));
}
