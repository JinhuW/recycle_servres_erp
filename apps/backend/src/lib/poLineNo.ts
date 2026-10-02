import type { SqlLike } from '../db';

// A line's number on its PO page — `#3` there must read `#3` everywhere else.
// Nothing stores it: the PO page numbers lines by their index in
// GET /api/orders/:id, so this is the same rank, by the same key that query
// orders by. Not `position + 1`: removed lines leave gaps, and a partial
// transfer clones a line at its source's position. created_at sits ahead of
// id so that clone (fresh now(), random uuid) always ranks after its source,
// and the source keeps the number a sell order already shows for it.
//
// Null when the aliased row is absent — a hand-typed sell-order line LEFT
// JOINs no lot, and the bare count would call it line 1.
export function poLineNo(sql: SqlLike, alias: string) {
  const l = sql(alias);
  return sql`CASE WHEN ${l}.id IS NULL THEN NULL ELSE (
    SELECT COUNT(*)::int + 1 FROM order_lines sib
     WHERE sib.order_id = ${l}.order_id
       AND (sib.position, sib.created_at, sib.id) < (${l}.position, ${l}.created_at, ${l}.id)
  ) END`;
}

// The order the PO page lists its lines in — poLineNo's rank, as ORDER BY.
export function poLineOrder(sql: SqlLike, alias: string) {
  const l = sql(alias);
  return sql`${l}.position ASC, ${l}.created_at ASC, ${l}.id ASC`;
}
