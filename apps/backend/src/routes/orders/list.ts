// GET /api/orders — the PO list: filters, sort, keyset paging, and the
// manager-only figures each row carries.
import { Hono } from 'hono';
import { linkedPaidFrag } from '../../banktx/match';
import { getDb } from '../../db';
import { clampLimit, cursorTs, cursorTsSelect, decodeCursor, encodeCursor, parseSort } from '../../lib/pagination';
import { effectiveRole } from '../../lib/role';
import { LIFECYCLE_LABEL, lifecyclesForLabel, visibleLifecycle } from '../../services/orderAdvance';
import { sortCategories } from '../../services/orderCategory';
import { poRealizedLateral } from '../../lib/po-cost';
import { realizedFromRow } from '../../services/poRealized';
import { type OrdersEnv, newestPackageJson, packageFromJson } from './shared';

const listRoutes = new Hono<OrdersEnv>();

// ── List orders for the signed-in purchaser (or all, if manager).
listRoutes.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // A manager in rolePreview=as_purchaser mode is scoped to their own POs,
  // matching what the FE shows so the two layers can't disagree.
  const role = effectiveRole(u);
  const isManager = role === 'manager';

  // The mobile capture flow's draft picker asks for `mine` so a manager only
  // ever appends scanned items to their own POs, not someone else's draft.
  const mineOnly = c.req.query('mine') === 'true';
  const category = c.req.query('category');                 // RAM/SSD/Other
  const status = c.req.query('status');                     // order stage label (Draft/In Transit/…)
  const includeArchived = c.req.query('includeArchived') === 'true';
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const sortRaw = c.req.query('sort');
  if (sortRaw && !parseSort('orders', sortRaw)) {
    return c.json({ error: 'sort column not allowed' }, 400);
  }
  const sort = parseSort('orders', sortRaw) ?? { col: 'created_at', dir: 'desc' as const };
  // The cursor's value is cast to the sort column's type in SQL, so one that
  // doesn't fit that type would 500 (and land in the error sink); it falls back
  // to page one instead, like every other list.
  const decoded = decodeCursor(c.req.query('cursor'));
  const cursorFits = decoded !== null && (
    sort.col === 'total_cost' ? typeof decoded.ts === 'number' && Number.isFinite(decoded.ts)
    : sort.col === 'lifecycle' ? typeof decoded.ts === 'string'
    : cursorTs(decoded) !== null);
  const cursor = cursorFits ? decoded : null;

  // Build the query in pieces to keep dynamic filters tidy. Each fragment
  // either narrows the result set or evaluates to TRUE so the AND chain
  // composes cleanly regardless of which params are present.
  //
  // Managers see every PO across the org; purchasers are scoped to their own.
  // `mine` overrides that and pins the list to the caller regardless of role.
  const scopeFrag    = isManager && !mineOnly
    ? sql`TRUE`
    : sql`o.user_id = ${u.id}`;
  // Matched against the LINES, not the order header: a PO may mix categories,
  // and header-matching would hide every mixed PO from every chip. Served by
  // order_lines_category_order_idx (migration 0083). A zero-line draft matches
  // no category, which is correct — it contains nothing.
  const categoryFrag = category
    ? sql`EXISTS (SELECT 1 FROM order_lines ocf WHERE ocf.order_id = o.id AND ocf.category = ${category})`
    : sql`TRUE`;
  // The mobile filter chip sends the order's stage label — map to lifecycle,
  // per reader: a purchaser's Done is done and sold together. Filtering on
  // per-line status (an earlier design) silently hid empty drafts and drafts
  // whose lines had already advanced past 'Draft'.
  const statusSlugs = status ? lifecyclesForLabel(status, role) : null;
  const statusFrag = statusSlugs === null
    ? sql`TRUE`
    : statusSlugs.length
      ? sql`o.lifecycle = ANY(${statusSlugs}::text[])`
      : sql`FALSE`;
  // The org-wide default view drowns in finished POs, so clients can carve
  // stages out (mobile sends excludeStatus=Done&excludeStatus=Sold unless a
  // chip is active). An unknown label excludes nothing — the mirror of
  // `status`, where an unknown label matches nothing.
  const excludeSlugs = (c.req.queries('excludeStatus') ?? []).flatMap((l) => lifecyclesForLabel(l, role));
  const excludeFrag = excludeSlugs.length
    ? sql`o.lifecycle <> ALL(${excludeSlugs}::text[])`
    : sql`TRUE`;
  // Archived orders drop out of the default view; clients opt in to see them.
  const archivedFrag = includeArchived ? sql`TRUE` : sql`o.archived_at IS NULL`;

  // Keyset pagination. The cursor compares on the ACTIVE sort column (with id
  // as the tiebreaker), not a fixed created_at — otherwise the WHERE boundary
  // and the ORDER BY disagree under a total_cost/lifecycle sort and pages
  // silently skip or duplicate rows. total_cost is COALESCEd so NULL overrides
  // order consistently in both the predicate and ORDER BY.
  const SORT_EXPR: Record<string, ReturnType<typeof sql>> = {
    created_at: sql`o.created_at`,
    total_cost: sql`COALESCE(o.total_cost, 0)`,
    lifecycle: sql`o.lifecycle`,
  };
  const SORT_CAST: Record<string, string> = {
    created_at: 'timestamptz',
    total_cost: 'numeric',
    lifecycle: 'text',
  };
  const sortExpr = SORT_EXPR[sort.col] ?? SORT_EXPR.created_at;
  // sortCast/sortDir come from fixed allowlists (SORT_CAST + parseSort), never
  // from user input, so sql.unsafe here cannot inject — hoisted onto their own
  // lines so the safety review lives next to the call.
  const castSql = sql.unsafe(SORT_CAST[sort.col] ?? SORT_CAST.created_at); // nosec
  const dirSql = sql.unsafe(sort.dir.toUpperCase()); // nosec
  const cursorFrag = cursor
    ? (sort.dir === 'desc'
        // Through ::text first: a bare $1::timestamptz parameter is serialised
        // via a JS Date, which drops the cursor's microseconds (pagination.ts).
        ? sql`AND (${sortExpr}, o.id) < ((${String(cursor.ts)}::text)::${castSql}, ${cursor.id})`
        : sql`AND (${sortExpr}, o.id) > ((${String(cursor.ts)}::text)::${castSql}, ${cursor.id})`)
    : sql`AND TRUE`;

  // Managers only: the figure and the Payments page it opens are.
  const linkedPaidSel = isManager ? linkedPaidFrag(sql) : sql`NULL`;

  const rows = await sql`
    SELECT
      o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
      ${cursorTsSelect(sql, sql`o.created_at`)} AS cursor_ts,
      o.archived_at,
      o.total_cost::float AS total_cost,
      o.other_fees::float AS other_fees,
      o.other_fees_note,
      o.paypal_txn_id,
      ${linkedPaidSel}::float AS linked_paid,
      o.handoff_method,
      mg.id AS manager_id, mg.name AS manager_name,
      ${newestPackageJson(sql)} AS pkg,
      o.supplier_id, sup.name AS supplier_name,
      u.name AS user_name, u.initials AS user_initials,
      o.commission_rate::float AS commission_rate,
      w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
      rz.sold_qty, rz.bought_qty, rz.revenue AS rz_revenue, rz.cost AS rz_cost,
      rz.projected_profit,
      COALESCE(SUM(l.qty), 0)::int                                                  AS qty,
      -- The goods figure the dashboard uses: the stored total (a mirror of the
      -- lines, or a negotiated lot price) and, for a row never written since
      -- the mirror existed, the line sum on the same qty_purchased basis.
      COALESCE(o.total_cost,
               SUM(COALESCE(l.qty_purchased, l.qty) * l.unit_cost), 0)::float        AS goods_total,
      -- A line with no sell price contributes nothing: NULL drops out of SUM.
      -- It used to fall back to unit_cost, which invented revenue equal to the
      -- cost — so a PO nobody had priced yet reported its full cost as
      -- projected revenue. The spreadsheet and the edit screen never did that;
      -- this is the list catching up to them.
      COALESCE(SUM(l.sell_price * l.qty), 0)::float                                 AS revenue,
      -- The whole fee nets against the margin, so a PO whose lines aren't
      -- priced yet reads as a loss the size of its fees. That is intended: the
      -- fee is money already spent. It does mean this figure is deliberately
      -- more conservative than the edit screen's tape, which reports margin on
      -- priced lines alone and says outright that fees are not allocated there.
      (COALESCE(SUM((l.sell_price - l.unit_cost) * l.qty), 0)
         - o.other_fees)::float                                                     AS profit,
      COUNT(l.id)::int                                                              AS line_count,
      -- So the UI can explain a revenue figure that looks low rather than
      -- leaving the reader to wonder.
      COUNT(l.id) FILTER (WHERE l.sell_price IS NULL)::int                           AS unpriced_line_count,
      -- The row chip needs every category present, not just the derived header
      -- value, so a mixed PO can show what it actually holds. Free here: the
      -- query already groups by o.id over the joined lines.
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT l.category), NULL)                            AS categories
    FROM orders o
    JOIN users u      ON u.id = o.user_id
    -- Only while still an active manager, as the advance reads it.
    LEFT JOIN users mg ON mg.id = o.manager_id AND mg.role = 'manager' AND mg.active
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    LEFT JOIN suppliers sup ON sup.id = o.supplier_id
                          AND (${isManager} OR sup.owner_id IS NULL OR sup.owner_id = ${u.id})
    ${poRealizedLateral(sql, isManager)}
    LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${excludeFrag} AND ${archivedFrag} ${cursorFrag}
    GROUP BY o.id, u.name, u.initials, mg.id, w.id, w.short, w.region, sup.name,
             rz.sold_qty, rz.bought_qty, rz.revenue, rz.cost, rz.projected_profit
    ORDER BY ${sortExpr} ${dirSql}, o.id ${dirSql}
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = slice[slice.length - 1] as { cursor_ts: string; total_cost: number | null; lifecycle: string; id: string };
    const sortVal: string | number =
      sort.col === 'total_cost' ? (last.total_cost ?? 0)
      : sort.col === 'lifecycle' ? last.lifecycle
      : last.cursor_ts;
    nextCursor = encodeCursor({ ts: sortVal, id: last.id });
  }

  return c.json({
    orders: slice.map(r => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userInitials: r.user_initials,
      commissionRate: r.commission_rate,
      category: r.category,
      categories: sortCategories((r.categories as string[] | null) ?? []),
      payment: r.payment,
      notes: r.notes,
      lifecycle: visibleLifecycle(r.lifecycle as string, role),
      archivedAt: r.archived_at,
      createdAt: r.created_at,
      totalCost: r.total_cost,
      otherFees: r.other_fees,
      otherFeesNote: r.other_fees_note,
      paypalTxnId: r.paypal_txn_id,
      // Managers only, and left out rather than nulled: the key alone would
      // name the Payments page it links to.
      ...(isManager ? { linkedPaid: r.linked_paid } : {}),
      handoffMethod: r.handoff_method,
      // Optional and additive, like handoffMethod: a stale SPA renders the
      // plain status chip.
      tracking: packageFromJson(r.pkg),
      // Optional and additive; the review-mode entry asks the takeover
      // question from the row.
      manager: r.manager_id ? { id: r.manager_id, name: r.manager_name ?? '' } : null,
      goodsTotal: r.goods_total,
      // Optional and additive: a stale SPA that never reads it is unaffected.
      // Keyed on the JOINED name, not the raw column: the join is scoped to the
      // caller's book, so a PO carrying someone else's client reads as unset
      // rather than leaking an id with a null name beside it.
      supplier: r.supplier_name ? { id: r.supplier_id, name: r.supplier_name } : null,
      warehouse: r.warehouse_id ? { id: r.warehouse_id, short: r.warehouse_short, region: r.warehouse_region } : null,
      qty: r.qty,
      revenue: r.revenue,
      profit: r.profit,
      // What the units earned on Done sell orders, net of the commission paid
      // — null until something sells. Managers only: the key is left out for
      // everyone else, since even a null would name the feature. Optional and
      // additive.
      ...(isManager ? {
        realized: realizedFromRow({
          sold_qty: r.sold_qty, bought_qty: r.bought_qty, revenue: r.rz_revenue, cost: r.rz_cost,
          projected_profit: r.projected_profit,
        }, { commission_rate: r.commission_rate }),
      } : {}),
      lineCount: r.line_count,
      unpricedLineCount: r.unpriced_line_count,
      // PO status is authoritative — derive from o.lifecycle, not from line
      // aggregation. Per-line `Sold` (set when inventory ships out via a sell
      // order) is intentional divergence and must not surface as "Mixed".
      status: LIFECYCLE_LABEL[visibleLifecycle(r.lifecycle as string, role)] ?? r.lifecycle,
    })),
    nextCursor,
  });
});

export default listRoutes;
