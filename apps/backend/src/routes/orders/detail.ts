// GET /api/orders/:id and its audit timeline — what the PO page loads.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { wasEverSubmitted } from '../../services/orderAudit';
import { effectiveRole } from '../../lib/role';
import { LIFECYCLE_LABEL, visibleLifecycle } from '../../services/orderAdvance';
import { txnRequiredFor, chatShotRequiredFor, cashShotRequiredFor, readCutoffs, leaveDraftBlockers } from '../../services/orderTxnRule';
import { allLimited } from '../../lib/concurrency';
import { sortCategories } from '../../services/orderCategory';
import { goodsTotalIsMirror } from '../../services/orderGoodsTotal';
import { poRealizedLateral } from '../../lib/po-cost';
import { realizedFromRow } from '../../services/poRealized';
import { linePhotos, type LinePhoto } from '../../lib/linePhotos';
import { poLineOrder } from '../../lib/poLineNo';
import { type OrdersEnv, newestPackageJson, packageFromJson, unackedRevertFrag } from './shared';

const detailRoutes = new Hono<OrdersEnv>();

// ── Get a single order with all its lines.
detailRoutes.get('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const role = effectiveRole(u);
  const isManager = role === 'manager';

  const order = (await sql`
    SELECT o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
           o.archived_at,
           o.total_cost::float AS total_cost,
           o.other_fees::float AS other_fees,
           o.other_fees_note,
           o.paypal_txn_id,
           o.source, o.handoff_method, o.handoff_by, o.payment_method,
           hb.name AS handoff_by_name,
           mg.id AS manager_id, mg.name AS manager_name,
           o.commission_paid_by, cpb.name AS commission_paid_by_name,
           o.supplier_id, sup.name AS supplier_name,
           o.commission_rate::float AS commission_rate,
           u.name AS user_name, u.initials AS user_initials,
           w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
           ${newestPackageJson(sql)} AS pkg,
           rz.sold_qty, rz.bought_qty, rz.revenue AS rz_revenue, rz.cost AS rz_cost,
           rz.projected_profit
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN users hb ON hb.id = o.handoff_by
    -- Only while still an active manager: the advance reads it the same way,
    -- so the client asks about exactly the manager the server would keep.
    LEFT JOIN users mg ON mg.id = o.manager_id AND mg.role = 'manager' AND mg.active
    -- Unfiltered, unlike mg: a record of who paid, kept after they leave.
    LEFT JOIN users cpb ON cpb.id = o.commission_paid_by
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    LEFT JOIN suppliers sup ON sup.id = o.supplier_id
                          AND (${isManager} OR sup.owner_id IS NULL
                               OR sup.owner_id = ${u.id})
    ${poRealizedLateral(sql, isManager)}
    WHERE o.id = ${id}
    LIMIT 1
  `)[0];

  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!isManager && order.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const lifecycle = visibleLifecycle(order.lifecycle as string, role);
  const status = LIFECYCLE_LABEL[lifecycle] ?? lifecycle;

  // Both feed several reads below, so each is read once up front.
  const [cutoffs, everSubmitted] = await allLimited([
    () => readCutoffs(sql),
    () => wasEverSubmitted(sql, id),
  ] as const);

  const [lines, sellOrders, metaRows, attRows, photoRows,
    txnRequired, chatShotRequired, cashShotRequired, blockers, pendingRevert,
    goodsFollowsLines] = await allLimited([
    // `fs` is what the units actually sold for — the qty-weighted unit price
    // over Done sell orders naming the line — as opposed to `sell_price`, the
    // projection that feeds commission. A partial sale leaves the remainder in
    // `qty`, so the sold count travels with the price.
    () => sql`
      SELECT ol.id, ol.category, ol.brand, ol.capacity, ol.generation, ol.type, ol.classification,
             ol.rank, ol.speed, ol.interface, ol.form_factor, ol.description, ol.item_type,
             ol.part_number, ol.serial_number, ol.chip_number, ol.condition, ol.qty,
             ol.unit_cost::float AS unit_cost, ol.sell_price::float AS sell_price,
             ol.status, ol.scan_image_id, ol.scan_confidence, ol.position,
             ol.health::float AS health, ol.rpm,
             ls.delivery_url AS scan_image_url,
             fs.final_sell_price, fs.sold_qty
      FROM order_lines ol
      LEFT JOIN label_scans ls ON ls.cf_image_id = ol.scan_image_id
      LEFT JOIN LATERAL (
        SELECT SUM(sol.qty)::int AS sold_qty,
               (SUM(sol.qty * sol.unit_price) / SUM(sol.qty))::float AS final_sell_price
        FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
        WHERE sol.inventory_id = ol.id AND so.status = 'Done'
      ) fs ON TRUE
      WHERE ol.order_id = ${id}
      ORDER BY ${poLineOrder(sql, 'ol')}
    `,
    // The sell orders that sold this PO's units — Done only, the same set the
    // final sell price reads. An archived Done order still sold them, so it stays.
    async () => isManager ? await sql<{ id: string; customer: string; qty: number }[]>`
      SELECT so.id, COALESCE(c.short_name, c.name) AS customer, SUM(sol.qty)::int AS qty
      FROM sell_order_lines sol
      JOIN order_lines ol ON ol.id = sol.inventory_id
      JOIN sell_orders so ON so.id = sol.sell_order_id
      JOIN customers c ON c.id = so.customer_id
      WHERE ol.order_id = ${id} AND so.status = 'Done'
      GROUP BY so.id, c.short_name, c.name
      ORDER BY so.id
    ` : null,
    // Per-status evidence (note + attachments) — currently captured only for
    // Done. Same response shape as sell orders' statusMeta.
    () => sql`
      SELECT status, note, set_at FROM order_status_meta WHERE order_id = ${id}
    `,
    () => sql`
      SELECT id, status, filename, size_bytes, mime_type, delivery_url, uploaded_at
      FROM order_status_attachments WHERE order_id = ${id} ORDER BY uploaded_at
    `,
    // One flat select stitched in JS rather than a lateral per line — same shape
    // as the status-meta rows above.
    () => sql`
      SELECT id, order_line_id, filename, size_bytes, mime_type, delivery_url, uploaded_at
      FROM order_line_photos WHERE order_id = ${id}
      ORDER BY order_line_id, position, uploaded_at
    `,
    // Whether the company-pay transaction-id rule governs this order. The cutoff
    // it depends on lives in the DB, so a shell that decided for itself would
    // block exactly the pre-cutoff drafts the rule exempts.
    () => txnRequiredFor(
      sql, order as { payment: string; payment_method: string | null; created_at: Date }, cutoffs),
    () => chatShotRequiredFor(
      sql, order as { payment: string; created_at: Date }, cutoffs),
    () => cashShotRequiredFor(
      sql, order as { payment: string; payment_method: string | null; created_at: Date }, cutoffs),
    // Everything still between this Draft and In Transit, in display order —
    // the same list the hand-off refuses on, read locally (no PayPal pull). A
    // non-Draft has nothing between it and anywhere.
    async () => order.lifecycle === 'draft' && !order.archived_at
      ? (await leaveDraftBlockers(sql, {
        id: order.id as string, payment: order.payment as string,
        payment_method: order.payment_method as string | null,
        paypal_txn_id: order.paypal_txn_id as string | null,
        created_at: order.created_at as Date, total_cost: order.total_cost as number | null,
        warehouse_id: order.warehouse_id as string | null,
        source: order.source as string | null, handoff_method: order.handoff_method as string | null,
        handoff_by: order.handoff_by as string | null, has_package: order.pkg != null,
      }, { cutoffs, everSubmitted })).map((b) => b.kind)
      : [],
    // Changes a purchaser made after submitting, that no manager has looked at
    // yet — the edit page opens a review dialog on them. Managers only: the
    // purchaser is the one who made the changes, and the key is left out rather
    // than nulled so the response doesn't name the review at all.
    async () => isManager
      ? (await sql`
          SELECT e.id, e.detail, e.created_at,
                 act.id AS actor_id, act.name AS actor_name, act.initials AS actor_initials
          FROM order_events e
          LEFT JOIN users act ON act.id = e.actor_id
          WHERE e.order_id = ${id} AND e.kind = 'reverted'
            AND ${unackedRevertFrag(sql, id)}
          ORDER BY e.created_at DESC, e.id DESC
        `).map(r => ({
          id: r.id,
          createdAt: r.created_at,
          detail: r.detail,
          actor: r.actor_id
            ? { id: r.actor_id, name: r.actor_name ?? '', initials: r.actor_initials ?? '' }
            : null,
        }))
      : undefined,
    () => goodsTotalIsMirror(sql, id),
  ] as const);

  const photosByLine = new Map<string, LinePhoto[]>();
  for (const p of photoRows) {
    const key = p.order_line_id as string;
    if (!photosByLine.has(key)) photosByLine.set(key, []);
    photosByLine.get(key)!.push({
      id: p.id as string,
      url: p.delivery_url as string,
      source: 'upload',
      filename: p.filename as string,
      mime: p.mime_type as string,
      uploadedAt: String(p.uploaded_at),
    });
  }

  const statusMeta: Record<string, {
    note: string | null; when: string;
    attachments: { id: string; filename: string; size: number; mime: string; url: string; uploadedAt: string }[];
  }> = {};
  for (const m of metaRows) {
    statusMeta[m.status as string] = { note: m.note, when: m.set_at, attachments: [] };
  }
  for (const a of attRows) {
    const s = a.status as string;
    statusMeta[s] ??= { note: null, when: a.uploaded_at, attachments: [] };
    statusMeta[s].attachments.push({
      id: a.id, filename: a.filename, size: a.size_bytes,
      mime: a.mime_type, url: a.delivery_url, uploadedAt: a.uploaded_at,
    });
  }

  return c.json({
    order: {
      id: order.id,
      userId: order.user_id,
      userName: order.user_name,
      userInitials: order.user_initials,
      category: order.category,
      categories: sortCategories([...new Set(lines.map(l => l.category as string).filter(Boolean))]),
      payment: order.payment,
      notes: order.notes,
      lifecycle,
      archivedAt: order.archived_at,
      status,
      statusMeta,
      ...(pendingRevert ? { pendingRevert } : {}),
      everSubmitted,
      createdAt: order.created_at,
      totalCost: order.total_cost,
      otherFees: order.other_fees,
      otherFeesNote: order.other_fees_note,
      paypalTxnId: order.paypal_txn_id,
      txnRequired,
      chatShotRequired,
      cashShotRequired,
      blockers,
      source: order.source,
      paymentMethod: order.payment_method,
      handoffMethod: order.handoff_method,
      handoffBy: order.handoff_by
        ? { id: order.handoff_by, name: order.handoff_by_name ?? '' }
        : null,
      // Every role: who is reviewing the order is a name, not money.
      manager: order.manager_id
        ? { id: order.manager_id, name: order.manager_name ?? '' }
        : null,
      supplier: order.supplier_name
        ? { id: order.supplier_id, name: order.supplier_name }
        : null,
      commissionRate: order.commission_rate,
      // Every role, as `manager` is: the purchaser may see who paid them.
      commissionPaidBy: order.commission_paid_by
        ? { id: order.commission_paid_by, name: order.commission_paid_by_name ?? '' }
        : null,
      // Whether total_cost tracks the lines or is a pinned lot price. The
      // client can't judge it: the lines it gets carry what is left, and the
      // verdict is on what was bought (orderGoodsTotal.ts), so a partly sold
      // PO would read as negotiated.
      goodsFollowsLines,
      // Manager-only keys are left out, not nulled, for everyone else — the
      // key alone would name the feature. Same rule as the list above.
      ...(isManager ? {
        realized: realizedFromRow({
          sold_qty: order.sold_qty, bought_qty: order.bought_qty,
          revenue: order.rz_revenue, cost: order.rz_cost,
          projected_profit: order.projected_profit,
        }, { commission_rate: order.commission_rate }),
        sellOrders,
      } : {}),
      warehouse: order.warehouse_id
        ? { id: order.warehouse_id, short: order.warehouse_short, region: order.warehouse_region }
        : null,
      // Count only — the mobile detail page renders a nav badge and shouldn't
      // have to download the labels themselves (those live on /shipping).
      // Optional and additive: a stale SPA that never reads it is unaffected.
      package: packageFromJson(order.pkg),
      lines: lines.map(l => ({
        id: l.id,
        category: l.category,
        photos: linePhotos(l, photosByLine.get(l.id as string)),
        brand: l.brand,
        capacity: l.capacity,
        generation: l.generation,
        type: l.type,
        classification: l.classification,
        rank: l.rank,
        speed: l.speed,
        interface: l.interface,
        formFactor: l.form_factor,
        description: l.description,
        itemType: l.item_type,
        partNumber: l.part_number,
        serialNumber: l.serial_number,
        chipNumber: l.chip_number,
        condition: l.condition,
        qty: l.qty,
        unitCost: l.unit_cost,
        sellPrice: l.sell_price,
        ...(isManager ? { finalSellPrice: l.final_sell_price, finalSoldQty: l.sold_qty } : {}),
        status: l.status,
        scanImageId: l.scan_image_id,
        scanConfidence: l.scan_confidence,
        scanImageUrl: l.scan_image_url ?? null,
        position: l.position,
        health: l.health,
        rpm: l.rpm,
      })),
    },
  });
});

// ── Audit timeline for a single order. Same access rules as GET /:id:
// owner + manager. Used by the PO edit page's Activity panel.
detailRoutes.get('/:id/events', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const owner = (await sql`SELECT user_id FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string } | undefined;
  if (!owner) return c.json({ error: 'Not found' }, 404);
  const role = effectiveRole(u);
  if (role !== 'manager' && owner.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const rows = await sql`
    SELECT e.id, e.kind, e.detail, e.created_at,
           act.id AS actor_id, act.name AS actor_name, act.initials AS actor_initials
    FROM order_events e
    LEFT JOIN users act ON act.id = e.actor_id
    WHERE e.order_id = ${id}
    ORDER BY e.created_at ASC, e.id ASC
  ` as Array<{
    id: string;
    kind: string;
    detail: Record<string, unknown>;
    created_at: string;
    actor_id: string | null;
    actor_name: string | null;
    actor_initials: string | null;
  }>;

  // A purchaser is shown Done for Sold everywhere else, so here the settle
  // row is dropped rather than shown as Done → Done, and a reopen from Sold
  // reads as a reopen from Done.
  // Sell orders are a manager's: the archive refusal names none to a
  // purchaser, so the archive event mustn't count them either.
  const visible = role === 'manager' ? rows : rows.flatMap((r) => {
    if (r.kind === 'archived') {
      const { removedSellOrderLines: _dropped, ...rest } = r.detail;
      return [{ ...r, detail: rest }];
    }
    if (r.kind !== 'advanced') return [r];
    const d = r.detail as { from?: string; to?: string };
    if (d.from === 'done' && d.to === 'sold') return [];
    if (d.from !== 'sold' && d.to !== 'sold') return [r];
    return [{ ...r, detail: { ...d, from: visibleLifecycle(d.from ?? '', role), to: visibleLifecycle(d.to ?? '', role) } }];
  });

  return c.json({
    events: visible.map(r => ({
      id: r.id,
      kind: r.kind,
      detail: r.detail,
      createdAt: r.created_at,
      actor: r.actor_id
        ? { id: r.actor_id, name: r.actor_name ?? '', initials: r.actor_initials ?? '' }
        : null,
    })),
  });
});

export default detailRoutes;
