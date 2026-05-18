import { Hono } from 'hono';
import { getDb } from '../db';
import { nextHumanId } from '../lib/id-seq';
import type { Env, User } from '../types';

const vendorBids = new Hono<{ Bindings: Env; Variables: { user: User } }>();

vendorBids.get('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const status = c.req.query('status');
  const statusFrag = status ? sql`b.status = ${status}` : sql`TRUE`;
  const rows = await sql`
    SELECT b.id, b.contact_name, b.note, b.status, b.created_at,
           cu.name AS customer_name, cu.short_name AS customer_short,
           COUNT(bl.id)::int AS line_count,
           COALESCE(SUM(bl.offered_qty * bl.offered_unit_price), 0)::float AS total_offered
    FROM vendor_bids b
    JOIN customers cu ON cu.id = b.customer_id
    LEFT JOIN vendor_bid_lines bl ON bl.bid_id = b.id
    WHERE ${statusFrag}
    GROUP BY b.id, cu.id
    ORDER BY b.created_at DESC
  `;
  return c.json({ items: rows });
});

vendorBids.get('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const head = (await sql`
    SELECT b.id, b.contact_name, b.note, b.status, b.created_at,
           cu.id AS customer_id, cu.name AS customer_name
    FROM vendor_bids b JOIN customers cu ON cu.id = b.customer_id
    WHERE b.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);
  const lines = await sql<{ id: string; inventory_id: string | null; label: string;
    sub_label: string | null; category: string; offered_qty: number;
    offered_unit_price: number; line_status: string; accepted_qty: number | null;
    accepted_unit_price: number | null; sell_order_id: string | null;
    available: number }[]>`
    SELECT bl.id, bl.inventory_id, bl.label, bl.sub_label, bl.category,
           bl.offered_qty, bl.offered_unit_price::float AS offered_unit_price,
           bl.line_status, bl.accepted_qty,
           bl.accepted_unit_price::float AS accepted_unit_price, bl.sell_order_id,
           COALESCE((SELECT ol.qty FROM order_lines ol
                     WHERE ol.id = bl.inventory_id AND ol.status = 'Done'), 0) AS available
    FROM vendor_bid_lines bl WHERE bl.bid_id = ${id} ORDER BY bl.position
  `;
  return c.json({ bid: { ...head, lines } });
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
    for (const d of body.lines) {
      const ln = (await tx<{ offered_qty: number; offered_unit_price: number;
        inventory_id: string | null }[]>`
        SELECT offered_qty, offered_unit_price::float AS offered_unit_price, inventory_id
        FROM vendor_bid_lines WHERE id = ${d.lineId} AND bid_id = ${id} FOR UPDATE
      `)[0];
      if (!ln) continue;
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
      const avail = (await tx<{ qty: number }[]>`
        SELECT COALESCE((SELECT qty FROM order_lines
          WHERE id=${ln.inventory_id} AND status='Done'),0) AS qty
      `)[0].qty;
      const wantQty = Number.isInteger(d.acceptedQty) ? (d.acceptedQty as number) : ln.offered_qty;
      const qty = Math.max(0, Math.min(wantQty, avail));
      const ap = d.acceptedUnitPrice;
      const price = (typeof ap === 'number' && Number.isFinite(ap) && ap >= 0 && ap <= 1e9)
        ? ap : ln.offered_unit_price;
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

  type Outcome = { code: 201; sellId: string } | { code: 400; msg: string };
  let outcome: Outcome = { code: 400, msg: 'no accepted lines to promote' };
  const sellId = await nextHumanId(sql, 'SL', 'SL');

  await sql.begin(async (tx) => {
    const head = (await tx<{ customer_id: string }[]>`
      SELECT customer_id FROM vendor_bids WHERE id=${id} LIMIT 1`)[0];
    if (!head) { outcome = { code: 400, msg: 'bid not found' }; return; }
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
    await tx`
      INSERT INTO sell_orders (id, customer_id, status, discount_pct, notes, created_by)
      VALUES (${sellId}, ${head.customer_id}, 'Draft', 0,
              ${'From vendor bid ' + id}, ${u.id})
    `;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await tx`
        INSERT INTO sell_order_lines
          (sell_order_id, inventory_id, category, label, sub_label, part_number,
           qty, unit_price, warehouse_id, condition, position)
        VALUES
          (${sellId}, ${l.inventory_id}, ${l.category}, ${l.label}, ${l.sub_label},
           ${l.part_number}, ${l.accepted_qty}, ${l.accepted_unit_price},
           NULL, NULL, ${i})
      `;
      await tx`UPDATE vendor_bid_lines SET sell_order_id=${sellId} WHERE id=${l.id}`;
    }
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
