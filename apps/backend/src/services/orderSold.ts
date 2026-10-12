import type postgres from 'postgres';
import type { SqlLike } from '../db';

type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

// Sold sits beside the stage, not on it: a PO from In Transit on whose every
// line with units is at line status Sold. Derived on read and never stored, so
// a line added, transferred, re-counted or walked off Sold changes the answer
// with nothing to keep in step. A 0-qty line never arrived, so there is
// nothing of it to sell. Managers only — the sale is the manager's book; the
// callers mask it for everyone else.
//
// `orderAlias` is the outer query's `orders` alias (`sql\`o\``). Inner aliases
// are odd on purpose so they never shadow the caller's.
export function soldFlagSql(sql: SqlLike, orderAlias: SqlFragment): SqlFragment {
  return sql`(${orderAlias}.lifecycle IN ('in_transit', 'reviewing', 'ready_to_pay', 'done')
      AND EXISTS (SELECT 1 FROM order_lines s_l
                   WHERE s_l.order_id = ${orderAlias}.id AND s_l.qty > 0)
      AND NOT EXISTS (SELECT 1 FROM order_lines s_l
                       WHERE s_l.order_id = ${orderAlias}.id AND s_l.qty > 0
                         AND s_l.status <> 'Sold'))`;
}

// Sold was a stage after Done from v1.164.0 until v1.246.0. Its history stays
// in order_events but reads in today's terms: the settle row (`advanced
// done→sold`) moved nothing and is dropped, and a reopen from Sold reads as
// one from Done. Every reader of order_events goes through this.
export function restageSoldEvent<T extends { kind: string; detail: Record<string, unknown> }>(r: T): T | null {
  if (r.kind !== 'advanced') return r;
  const d = r.detail as { from?: unknown; to?: unknown };
  if (d.to === 'sold') return null;
  if (d.from !== 'sold') return r;
  return { ...r, detail: { ...r.detail, from: 'done' } };
}

/** The SQL twin of restageSoldEvent's drop, for a reader that pages in SQL. */
export function soldSettleEventSql(sql: SqlLike, eventAlias: SqlFragment): SqlFragment {
  return sql`(${eventAlias}.kind = 'advanced' AND ${eventAlias}.detail->>'to' IS NOT DISTINCT FROM 'sold')`;
}
