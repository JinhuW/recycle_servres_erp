import type { SqlLike } from '../db';

// A product's # on its PO — `#3` there reads `#3` everywhere else. It is
// stored (order_lines.product_no, migration 0169): given once when the product
// is put on the PO and never recomputed, so removing a product leaves a gap and
// a partial transfer's clone carries its source's #.
//
// Null when the aliased row is absent — a hand-typed sell-order line LEFT
// JOINs no lot.
export function poLineNo(sql: SqlLike, alias: string) {
  return sql`${sql(alias)}.product_no`;
}

// The order the PO page lists its products in: by #, and a transfer clone —
// same # — after its source.
export function poLineOrder(sql: SqlLike, alias: string) {
  const l = sql(alias);
  return sql`${l}.product_no ASC, ${l}.created_at ASC, ${l}.id ASC`;
}

// The order a sell order's lines are read in. It is NOT their #, which is
// stored on the line (product_no, services/sellOrderNumbers.ts). Every save
// writes `position` as the editor's index; the tiebreak only settles rows
// older than that.
export function sellLineOrder(sql: SqlLike, alias: string) {
  const l = sql(alias);
  return sql`${l}.position ASC, ${l}.created_at ASC, ${l}.id ASC`;
}
