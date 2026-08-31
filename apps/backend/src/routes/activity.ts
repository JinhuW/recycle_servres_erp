import { Hono } from 'hono';
import {
  ACTIVITY_ACTIONS, ACTIVITY_AREAS, ACTIVITY_KIND_MAP, kindsForAction,
  type ActivityAction, type ActivityArea,
} from '@recycle-erp/shared';
import { getDb } from '../db';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination';
import type { Env, User } from '../types';

// Workspace-wide activity feed — the union of all four audit ledgers
// (order_events, sell_order_events, inventory_events, ref_price_events) as one
// reverse-chronological record. Drives the desktop Activity page.
//
// Read-only. Every source table is append-only by trigger; nothing here writes.

const activity = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type FeedRow = {
  area: ActivityArea;
  id: string;
  created_at: string | Date;
  actor_id: string | null;
  actor_name: string | null;
  actor_initials: string | null;
  target: string;
  target_ref: string | null;
  kind: string;
  detail: Record<string, unknown>;
};

activity.get('/', async (c) => {
  // Deliberately `user.role`, not effectiveRole(): a manager previewing the app
  // as a purchaser is using a viewing convenience, and shouldn't lose the audit
  // page in the process.
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const sql = getDb(c.env);

  const areaRaw = c.req.query('area');
  const area = ACTIVITY_AREAS.includes(areaRaw as ActivityArea)
    ? (areaRaw as ActivityArea) : null;
  if (areaRaw && !area) return c.json({ error: 'unknown area' }, 400);

  const actionRaw = c.req.query('action');
  const action = ACTIVITY_ACTIONS.includes(actionRaw as ActivityAction)
    ? (actionRaw as ActivityAction) : null;
  if (actionRaw && !action) return c.json({ error: 'unknown action' }, 400);

  const actor = c.req.query('actor') || null;
  const since = c.req.query('since') || null;   // ISO timestamp, inclusive
  const search = c.req.query('q')?.toLowerCase().trim() || null;
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));

  // ── Filter fragments, shared by the feed and the pill counts ──────────────
  // Keyset on (created_at, id) — the tiebreaker shape lib/pagination.ts
  // documents. Both columns stay uncast so each branch can use its *_feed_idx
  // from migration 0079; all four ledgers key on uuid, so the id compare is
  // type-clean.
  const cursorFrag = cursor
    ? sql`(e.created_at, e.id) < (${String(cursor.ts)}::timestamptz, ${cursor.id}::uuid)`
    : sql`TRUE`;
  const sinceFrag = since ? sql`e.created_at >= ${since}::timestamptz` : sql`TRUE`;

  // An action that can't occur in a ledger must match nothing there. Returning
  // TRUE would silently widen the filter to that entire ledger.
  const kindFrag = (a: Exclude<ActivityArea, 'price'>) => {
    if (!action) return sql`TRUE`;
    const kinds = kindsForAction(a, action);
    return kinds.length ? sql`e.kind = ANY(${kinds})` : sql`FALSE`;
  };
  const actorFrag = (col: 'actor_id' | 'actor_user_id') =>
    actor ? sql`e.${sql(col)} = ${actor}::uuid` : sql`TRUE`;
  const like = (col: string) =>
    sql`LOWER(COALESCE(${sql.unsafe(col)}, '')) LIKE '%' || ${search} || '%'`;
  const searchFrag = (cols: string[]) => {
    if (!search) return sql`TRUE`;
    return cols.slice(1).reduce((acc, col) => sql`${acc} OR ${like(col)}`, like(cols[0]));
  };

  const WHERE = {
    po: sql`${sinceFrag} AND ${kindFrag('po')} AND ${actorFrag('actor_id')}
            AND (${searchFrag(['e.order_id', 'act.name'])})`,
    so: sql`${sinceFrag} AND ${kindFrag('so')} AND ${actorFrag('actor_id')}
            AND (${searchFrag(['e.sell_order_id', 'act.name'])})`,
    inv: sql`${sinceFrag} AND ${kindFrag('inv')} AND ${actorFrag('actor_id')}
            AND (${searchFrag(['l.part_number', 'l.brand', 'l.description', 'act.name'])})`,
    // Every ref_price_events row is a `priced` action, so any other action
    // filter excludes the branch outright.
    price: sql`${!action || action === 'priced' ? sql`TRUE` : sql`FALSE`}
            AND ${sinceFrag} AND ${actorFrag('actor_user_id')}
            AND (${searchFrag(['rp.part_number', 'rp.label', 'act.name'])})`,
  };

  const FROM = {
    po: sql`FROM order_events e LEFT JOIN users act ON act.id = e.actor_id`,
    so: sql`FROM sell_order_events e LEFT JOIN users act ON act.id = e.actor_id`,
    // inventory_events keys on the line, so join through for item identity —
    // the same joins as GET /api/inventory/events/all.
    inv: sql`FROM inventory_events e
             JOIN order_lines l ON l.id = e.order_line_id
             LEFT JOIN users act ON act.id = e.actor_id`,
    price: sql`FROM ref_price_events e
               JOIN ref_prices rp ON rp.id = e.ref_price_id
               LEFT JOIN users act ON act.id = e.actor_user_id`,
  };

  // ── Feed ──────────────────────────────────────────────────────────────────
  // Each branch pre-sorts and pre-limits, so the union merges four short lists
  // rather than materialising four whole ledgers.
  const tail = (a: ActivityArea) =>
    sql`${FROM[a]} WHERE ${cursorFrag} AND ${WHERE[a]}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit + 1}`;

  const BRANCH: Record<ActivityArea, ReturnType<typeof sql>> = {
    po: sql`SELECT 'po' AS area, e.id AS id, e.created_at,
              e.actor_id AS actor_id, act.name AS actor_name, act.initials AS actor_initials,
              e.order_id AS target, e.order_id AS target_ref, e.kind, e.detail
            ${tail('po')}`,
    so: sql`SELECT 'so' AS area, e.id AS id, e.created_at,
              e.actor_id AS actor_id, act.name AS actor_name, act.initials AS actor_initials,
              e.sell_order_id AS target, e.sell_order_id AS target_ref, e.kind, e.detail
            ${tail('so')}`,
    inv: sql`SELECT 'inv' AS area, e.id AS id, e.created_at,
              e.actor_id AS actor_id, act.name AS actor_name, act.initials AS actor_initials,
              COALESCE(NULLIF(l.part_number, ''), NULLIF(l.description, ''),
                       LEFT(l.id::text, 8)) AS target,
              l.id::text AS target_ref, e.kind, e.detail
            ${tail('inv')}`,
    // ref_price_events is the odd one out: its actor column is actor_user_id
    // (ON DELETE SET NULL, so unattributed rows are normal), and it has no kind
    // and no detail — only price, source and note. Synthesise both so the row
    // shape matches its siblings.
    price: sql`SELECT 'price' AS area, e.id AS id, e.created_at,
              e.actor_user_id AS actor_id, act.name AS actor_name, act.initials AS actor_initials,
              COALESCE(NULLIF(rp.part_number, ''), rp.label) AS target,
              e.ref_price_id AS target_ref, 'priced' AS kind,
              jsonb_build_object('price', e.price, 'source', e.source, 'note', e.note) AS detail
            ${tail('price')}`,
  };

  // Each branch must be parenthesised: an unwrapped ORDER BY / LIMIT binds to
  // the whole union, not to the branch it was written on.
  const wanted = ACTIVITY_AREAS.filter(a => !area || area === a);
  const union = wanted
    .map(a => sql`(${BRANCH[a]})`)
    .reduce((acc, b) => sql`${acc} UNION ALL ${b}`);

  const rows = await sql<FeedRow[]>`
    WITH feed AS (${union})
    SELECT * FROM feed ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({
        ts: last.created_at instanceof Date
          ? last.created_at.toISOString()
          : String(last.created_at),
        id: last.id,
      })
    : null;

  // ── Pill counts ───────────────────────────────────────────────────────────
  // These ignore the area filter — that's the axis they let you switch — but
  // respect every other one, so the number tells you whether the click is
  // worth making. No cursor and no limit: it counts the whole filtered set.
  //
  // Which is exactly why it only runs on the first page. The count deliberately
  // ignores the cursor, so every infinite-scroll page used to re-run the same
  // full four-ledger COUNT and get the same answer. Omitted on cursored pages;
  // the client keeps the numbers it already has.
  let counts: Record<string, number> | undefined;
  if (!cursor) {
    const countRows = await sql<{ area: ActivityArea; n: number }[]>`
      SELECT area, COUNT(*)::int AS n FROM (
        SELECT 'po'    AS area ${FROM.po}    WHERE ${WHERE.po}
        UNION ALL SELECT 'so'  ${FROM.so}    WHERE ${WHERE.so}
        UNION ALL SELECT 'inv' ${FROM.inv}   WHERE ${WHERE.inv}
        UNION ALL SELECT 'price' ${FROM.price} WHERE ${WHERE.price}
      ) t GROUP BY area
    `;

    counts = { all: 0, po: 0, so: 0, inv: 0, price: 0 };
    for (const r of countRows) {
      counts[r.area] = r.n;
      counts.all += r.n;
    }
  }

  return c.json({
    events: slice.map(r => ({
      id: r.id,
      area: r.area,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      kind: r.kind,
      action: r.area === 'price' ? 'priced' : ACTIVITY_KIND_MAP[r.area][r.kind] ?? 'edited',
      target: r.target,
      targetRef: r.target_ref,
      detail: r.detail,
      actor: r.actor_id
        ? { id: r.actor_id, name: r.actor_name, initials: r.actor_initials }
        : null,
    })),
    counts,
    nextCursor,
  });
});

export default activity;
