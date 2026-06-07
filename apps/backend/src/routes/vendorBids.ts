import { Hono } from 'hono';
import { getDb } from '../db';
import { nextHumanId } from '../lib/id-seq';
import { writeSellOrderEvent } from '../services/sellOrderAudit';
import { getLatestRateToUsd, type SupportedCurrency } from '../lib/fx';
import type { Env, User } from '../types';

const vendorBids = new Hono<{ Bindings: Env; Variables: { user: User } }>();

vendorBids.get('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const status = c.req.query('status');
  const statusFrag = status ? sql`b.status = ${status}` : sql`TRUE`;
  const rows = await sql<{ id: string; contact_name: string; note: string | null;
    status: string; created_at: string; customer_name: string | null; customer_short: string | null;
    line_count: number; total_offered: number;
    currency_code: string; fx_rate_to_usd: number; fx_source: string }[]>`
    SELECT b.id, b.contact_name, b.note, b.status, b.created_at,
           cu.name AS customer_name, cu.short_name AS customer_short,
           COUNT(bl.id)::int AS line_count,
           COALESCE(SUM(bl.offered_qty * bl.offered_unit_price), 0)::float AS total_offered,
           b.currency_code,
           b.fx_rate_to_usd::float AS fx_rate_to_usd,
           b.fx_source
    FROM vendor_bids b
    LEFT JOIN customers cu ON cu.id = b.customer_id
    LEFT JOIN vendor_bid_lines bl ON bl.bid_id = b.id
    WHERE ${statusFrag}
    GROUP BY b.id, cu.id
    ORDER BY b.created_at DESC
  `;
  // The stored fx_rate_to_usd is already multiplier-to-USD (vendorPublic
  // freezes 1/frankfurter at submit time, USD bids get 1). Apply per-bid as
  // a flat multiplier instead of aggregating in SQL — keeps the join shape
  // unchanged and avoids a second round-trip.
  const items = rows.map(r => ({
    ...r,
    currency: r.currency_code,
    fxRateToUsd: r.fx_rate_to_usd,
    fxSource: r.fx_source,
    totalOfferedUsd: Math.round(r.total_offered * r.fx_rate_to_usd * 100) / 100,
  }));
  return c.json({ items });
});

vendorBids.get('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const head = (await sql<{ id: string; contact_name: string; note: string | null;
    status: string; created_at: string; customer_id: string | null; customer_name: string | null;
    currency_code: string; fx_rate_to_usd: number; fx_source: string }[]>`
    SELECT b.id, b.contact_name, b.note, b.status, b.created_at,
           cu.id AS customer_id, cu.name AS customer_name,
           b.currency_code,
           b.fx_rate_to_usd::float AS fx_rate_to_usd,
           b.fx_source
    FROM vendor_bids b LEFT JOIN customers cu ON cu.id = b.customer_id
    WHERE b.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);
  const lines = await sql<{ id: string; inventory_id: string | null; label: string;
    sub_label: string | null; category: string; offered_qty: number;
    offered_unit_price: number; line_status: string; accepted_qty: number | null;
    accepted_unit_price: number | null; sell_order_id: string | null;
    available: number; decline_reason: string | null }[]>`
    SELECT bl.id, bl.inventory_id, bl.label, bl.sub_label, bl.category,
           bl.offered_qty, bl.offered_unit_price::float AS offered_unit_price,
           bl.line_status, bl.accepted_qty,
           bl.accepted_unit_price::float AS accepted_unit_price, bl.sell_order_id,
           bl.decline_reason,
           COALESCE((SELECT ol.qty FROM order_lines ol
                     WHERE ol.id = bl.inventory_id AND ol.status = 'Done'), 0) AS available
    FROM vendor_bid_lines bl WHERE bl.bid_id = ${id} ORDER BY bl.position
  `;
  const linesOut = lines.map(l => ({
    ...l,
    unitPriceUsd: Math.round(l.offered_unit_price * head.fx_rate_to_usd * 100) / 100,
  }));
  return c.json({
    bid: {
      ...head,
      currency: head.currency_code,
      fxRateToUsd: head.fx_rate_to_usd,
      fxSource: head.fx_source,
      lines: linesOut,
    },
  });
});

vendorBids.post('/:id/decide', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { lines: { lineId: string; decision: 'accepted' | 'declined';
        acceptedQty?: number; acceptedUnitPrice?: number }[] }
    | null;
  if (!body || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'lines required' }, 400);
  }

  await sql.begin(async (tx) => {
    // Bulk-lock all targeted lines in one query (N+1 collapse). Only lines
    // that belong to this bid and are not yet promoted (sell_order_id IS NULL)
    // are lockable — promoted lines are silently skipped (existing behaviour).
    const lineIds = body.lines.map(d => d.lineId);
    const locked = await tx<{ id: string; offered_qty: number; offered_unit_price: number;
      inventory_id: string | null }[]>`
      SELECT id, offered_qty, offered_unit_price::float AS offered_unit_price, inventory_id
      FROM vendor_bid_lines
      WHERE id = ANY(${lineIds}::uuid[]) AND bid_id = ${id} AND sell_order_id IS NULL
      FOR UPDATE
    `;
    const lockedMap = new Map(locked.map(l => [l.id, l]));

    // Bulk-read availability for all inventory-backed lines in one query.
    const inventoryIds = locked
      .map(l => l.inventory_id)
      .filter((v): v is string => v !== null);
    const availRows = inventoryIds.length > 0
      ? await tx<{ id: string; qty: number }[]>`
          SELECT id, qty FROM order_lines
          WHERE id = ANY(${inventoryIds}::uuid[]) AND status = 'Done'
        `
      : [] as { id: string; qty: number }[];
    const availMap = new Map(availRows.map(r => [r.id, r.qty]));

    for (const d of body.lines) {
      const ln = lockedMap.get(d.lineId);
      if (!ln) continue; // not found or already promoted — skip
      if (d.decision !== 'accepted' && d.decision !== 'declined') continue;
      if (d.decision === 'declined') {
        await tx`
          UPDATE vendor_bid_lines
          SET line_status='declined', accepted_qty=NULL, accepted_unit_price=NULL,
              decided_at=NOW(), decided_by=${u.id}
          WHERE id=${d.lineId}
        `;
        continue;
      }
      const avail = ln.inventory_id !== null ? (availMap.get(ln.inventory_id) ?? 0) : Infinity;
      const wantQty = Number.isInteger(d.acceptedQty) ? (d.acceptedQty as number) : ln.offered_qty;
      const qty = Math.max(0, Math.min(wantQty, avail === Infinity ? wantQty : avail));
      const ap = d.acceptedUnitPrice;
      const price = (typeof ap === 'number' && Number.isFinite(ap) && ap >= 0 && ap <= 1e9)
        ? ap : ln.offered_unit_price;
      // The manager said "accept" but the referenced inventory has been
      // closed / consumed since the bid arrived (avail==0). Silently
      // writing accepted_qty=0 looked accepted to the vendor while being
      // unpromotable to a sell order. Flip to declined with a reason so the
      // vendor portal shows the truth.
      if (qty <= 0) {
        await tx`
          UPDATE vendor_bid_lines
          SET line_status='declined', accepted_qty=NULL, accepted_unit_price=NULL,
              decided_at=NOW(), decided_by=${u.id},
              decline_reason='no longer available'
          WHERE id=${d.lineId}
        `;
        continue;
      }
      await tx`
        UPDATE vendor_bid_lines
        SET line_status='accepted', accepted_qty=${qty}, accepted_unit_price=${price},
            decided_at=NOW(), decided_by=${u.id}
        WHERE id=${d.lineId}
      `;
    }
    const counts = (await tx<{ pending: number; total: number }[]>`
      SELECT COUNT(*) FILTER (WHERE line_status='pending')::int AS pending,
             COUNT(*)::int AS total
      FROM vendor_bid_lines WHERE bid_id=${id}
    `)[0];
    const next = counts.pending === 0 ? 'decided'
      : counts.pending === counts.total ? 'new' : 'partly_decided';
    await tx`UPDATE vendor_bids SET status=${next} WHERE id=${id}`;
  });
  return c.json({ ok: true });
});

vendorBids.post('/:id/promote', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { customerId?: string } | null;
  const bodyCustomerId = typeof body?.customerId === 'string' ? body.customerId : null;

  type Outcome = { code: 201; sellId: string } | { code: 400; msg: string };
  let outcome: Outcome = { code: 400, msg: 'no accepted lines to promote' };
  let sellId!: string;

  await sql.begin(async (tx) => {
    sellId = await nextHumanId(tx, 'SO', 'SO');
    const head = (await tx<{ customer_id: string | null; currency_code: SupportedCurrency }[]>`
      SELECT customer_id, currency_code FROM vendor_bids WHERE id=${id} LIMIT 1`)[0];
    if (!head) { outcome = { code: 400, msg: 'bid not found' }; return; }

    // A bid from a general (customer-less) link carries no customer. The
    // manager must choose one at promote time — sell_orders.customer_id is
    // NOT NULL. Persist the choice back onto the bid for attribution.
    let customerId = head.customer_id;
    if (!customerId) {
      if (!bodyCustomerId) { outcome = { code: 400, msg: 'customer required' }; return; }
      const exists = (await tx<{ id: string }[]>`
        SELECT id FROM customers WHERE id = ${bodyCustomerId} LIMIT 1`)[0];
      if (!exists) { outcome = { code: 400, msg: 'customer not found' }; return; }
      customerId = bodyCustomerId;
      await tx`UPDATE vendor_bids SET customer_id = ${customerId} WHERE id = ${id}`;
    }

    const fx = await getLatestRateToUsd(tx, head.currency_code);
    const isNonUsd = head.currency_code !== 'USD';

    const lines = await tx<{ id: string; inventory_id: string | null; category: string;
      label: string; sub_label: string | null; part_number: string | null;
      accepted_qty: number; accepted_unit_price: number }[]>`
      SELECT id, inventory_id, category, label, sub_label, part_number,
             accepted_qty, accepted_unit_price::float AS accepted_unit_price
      FROM vendor_bid_lines
      WHERE bid_id=${id} AND line_status='accepted'
        AND sell_order_id IS NULL AND accepted_qty > 0
      ORDER BY position FOR UPDATE
    `;
    if (lines.length === 0) { outcome = { code: 400, msg: 'no accepted lines to promote' }; return; }

    // accepted_qty was recorded at decide-time. Revalidate the underlying
    // inventory under a row lock before creating sell-order lines, exactly
    // like validateSellLines does for a normal sell order — otherwise stock
    // consumed/closed since decide gets oversold. Manual lines (no
    // inventory_id) skip the check.
    for (const l of lines) {
      if (!l.inventory_id) continue;
      const inv = (await tx<{ qty: number; status: string }[]>`
        SELECT qty, status FROM order_lines WHERE id = ${l.inventory_id} LIMIT 1 FOR UPDATE
      `)[0];
      if (!inv) {
        outcome = { code: 400, msg: `inventory line ${l.inventory_id} not found` }; return;
      }
      if (inv.status !== 'Reviewing' && inv.status !== 'Done') {
        outcome = { code: 400, msg: `inventory line not sellable (status=${inv.status})` }; return;
      }
      if (l.accepted_qty > inv.qty) {
        outcome = { code: 400, msg: `qty ${l.accepted_qty} exceeds inventory available ${inv.qty}` }; return;
      }
    }

    await tx`
      INSERT INTO sell_orders (id, customer_id, status, notes, created_by,
                               currency_code, fx_rate_to_usd, fx_source)
      VALUES (${sellId}, ${customerId}, 'Draft',
              ${'From vendor bid ' + id}, ${u.id},
              ${head.currency_code}, ${fx.rate}, ${fx.source})
    `;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const unitPriceUsd = isNonUsd
        ? Math.round(l.accepted_unit_price * fx.rate * 100) / 100
        : l.accepted_unit_price;
      await tx`
        INSERT INTO sell_order_lines
          (sell_order_id, inventory_id, category, label, sub_label, part_number,
           qty, unit_price, warehouse_id, condition, position,
           source_currency, source_unit_price, source_fx_rate_to_usd)
        VALUES
          (${sellId}, ${l.inventory_id}, ${l.category}, ${l.label}, ${l.sub_label},
           ${l.part_number}, ${l.accepted_qty}, ${unitPriceUsd},
           NULL, NULL, ${i},
           ${isNonUsd ? head.currency_code : null},
           ${isNonUsd ? l.accepted_unit_price : null},
           ${isNonUsd ? fx.rate : null})
      `;
      await tx`UPDATE vendor_bid_lines SET sell_order_id=${sellId} WHERE id=${l.id}`;
    }
    await writeSellOrderEvent(tx, sellId, u.id, 'created', {
      source: 'vendor_bid',
      vendorBidId: id,
      status: 'Draft',
      lineCount: lines.length,
      customerId: customerId,
      currency: head.currency_code,
      fxRateToUsd: fx.rate,
      fxSource: fx.source,
      fxEffectiveDate: fx.effectiveDate,
    });
    outcome = { code: 201, sellId };
  });

  // `outcome` is set inside the sql.begin closure; TS control-flow narrowing
  // can't see those assignments and pins it to the initializer type, so cast
  // back to the declared union before branching (same `as` pattern as
  // vendorPublic.ts / sellOrders.ts's post-tx outcome handling).
  const result = outcome as Outcome;
  if (result.code !== 201) return c.json({ error: result.msg }, 400);
  return c.json({ sellOrderId: result.sellId }, 201);
});

export default vendorBids;
