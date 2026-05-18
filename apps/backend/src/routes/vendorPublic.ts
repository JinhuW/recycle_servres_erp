import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env } from '../types';
import { nextHumanId } from '../lib/id-seq';
import { notifyManagers } from '../lib/notify';

const vendorPublic = new Hono<{ Bindings: Env }>();

type Link = { id: string; customer_id: string; label: string | null };

// Resolve a token to an active, non-expired link. Any miss returns null so
// callers can answer a uniform 404 (never reveal whether a token exists).
async function loadLink(sql: ReturnType<typeof getDb>, token: string): Promise<Link | null> {
  if (!token) return null;
  const rows = await sql<Link[]>`
    SELECT id, customer_id, label
    FROM vendor_links
    WHERE token = ${token} AND active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `;
  return rows[0] ?? null;
}

vendorPublic.get('/:token/me', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);
  const cust = (await sql<{ name: string; short_name: string | null }[]>`
    SELECT name, short_name FROM customers WHERE id = ${link.customer_id} LIMIT 1
  `)[0];
  if (!cust) return c.json({ error: 'Not found' }, 404);
  return c.json({ customer: { name: cust.name, short: cust.short_name }, label: link.label });
});

vendorPublic.get('/:token/catalog', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  // Best-effort touch; ignore failures.
  await sql`UPDATE vendor_links SET last_seen_at = NOW() WHERE id = ${link.id}`.catch(() => {});

  // Explicit non-cost column list. NEVER select unit_cost / sell_price /
  // profit / margin / notes / user / warehouse.
  const rows = await sql<Record<string, unknown>[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
           l.classification, l.rank, l.speed, l.interface, l.form_factor,
           l.description, l.part_number, l.condition, l.qty
    FROM order_lines l
    WHERE l.status = 'Done' AND l.qty > 0
    ORDER BY l.category, l.brand, l.created_at DESC
    LIMIT 2000
  `;
  const groups: { category: string; items: Record<string, unknown>[] }[] = [];
  for (const r of rows) {
    const cat = r.category as string;
    let g = groups.find(x => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(r);
  }
  return c.json({ groups });
});

type BidLineIn = { inventoryId: string; qty: number; unitPrice: number };

vendorPublic.post('/:token/bids', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  const body = (await c.req.json().catch(() => null)) as
    | { contactName?: string; note?: string; lines?: BidLineIn[] }
    | null;
  const contactName = (body?.contactName ?? '').trim();
  const lines = Array.isArray(body?.lines) ? body!.lines : [];
  const note = (body?.note ?? '').slice(0, 2000) || null;
  if (!contactName || contactName.length > 120) {
    return c.json({ error: 'contactName required (<=120 chars)' }, 400);
  }
  if (lines.length < 1 || lines.length > 100) {
    return c.json({ error: 'lines must have 1..100 entries' }, 400);
  }
  for (const l of lines) {
    if (!l.inventoryId || !Number.isInteger(l.qty) || l.qty <= 0 ||
        !Number.isFinite(l.unitPrice) || l.unitPrice < 0 || l.unitPrice > 1e9) {
      return c.json({ error: 'each line needs inventoryId, qty>0, unitPrice>=0' }, 400);
    }
  }

  type Outcome =
    | { code: 201; bidId: string }
    | { code: 409; bad: string[] }
    | { code: 400; msg: string };
  let outcome: Outcome = { code: 400, msg: 'unknown' };

  const bidId = await nextHumanId(sql, 'VB', 'VB');

  await sql.begin(async (tx) => {
    const bad: string[] = [];
    const snap: Record<string, { category: string; label: string; sub: string | null; pn: string | null }> = {};
    for (const l of lines) {
      const row = (await tx<{ category: string; brand: string | null; capacity: string | null;
        type: string | null; part_number: string | null; qty: number; status: string }[]>`
        SELECT category, brand, capacity, type, part_number, qty, status
        FROM order_lines WHERE id = ${l.inventoryId} FOR UPDATE
      `)[0];
      if (!row || row.status !== 'Done' || row.qty < l.qty) { bad.push(l.inventoryId); continue; }
      snap[l.inventoryId] = {
        category: row.category,
        label: [row.brand, row.capacity, row.type].filter(Boolean).join(' ') || row.category,
        sub: row.part_number,
        pn: row.part_number,
      };
    }
    if (bad.length) { outcome = { code: 409, bad }; return; } // roll back

    await tx`
      INSERT INTO vendor_bids (id, vendor_link_id, customer_id, contact_name, note)
      VALUES (${bidId}, ${link.id}, ${link.customer_id}, ${contactName}, ${note})
    `;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; const s = snap[l.inventoryId];
      await tx`
        INSERT INTO vendor_bid_lines
          (bid_id, inventory_id, category, label, sub_label, part_number,
           offered_qty, offered_unit_price, position)
        VALUES
          (${bidId}, ${l.inventoryId}, ${s.category}, ${s.label}, ${s.sub},
           ${s.pn}, ${l.qty}, ${l.unitPrice}, ${i})
      `;
    }
    await notifyManagers(tx, {
      kind: 'vendor_bid', tone: 'info', icon: 'tag',
      title: 'New vendor offer',
      body: `${lines.length} item(s) from ${contactName}`,
    });
    outcome = { code: 201, bidId };
  });

  // `outcome` is set inside the sql.begin closure; TS control-flow narrowing
  // can't see those assignments and pins it to the initializer type, so cast
  // back to the declared union before branching (same `as` pattern as
  // sellOrders.ts's post-tx outcome handling).
  const result = outcome as Outcome;
  if (result.code === 409) return c.json({ error: 'Some items are no longer available', unavailable: result.bad }, 409);
  if (result.code !== 201) return c.json({ error: result.msg }, 400);
  return c.json({ bidId: result.bidId }, 201);
});

vendorPublic.get('/:token/bids', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  const bids = await sql<{ id: string; contact_name: string; note: string | null;
    status: string; created_at: string }[]>`
    SELECT id, contact_name, note, status, created_at
    FROM vendor_bids WHERE vendor_link_id = ${link.id}
    ORDER BY created_at DESC
  `;
  const lines = await sql<{ bid_id: string; label: string; offered_qty: number;
    offered_unit_price: number; line_status: string;
    accepted_qty: number | null; accepted_unit_price: number | null }[]>`
    SELECT bid_id, label, offered_qty, offered_unit_price::float AS offered_unit_price,
           line_status, accepted_qty, accepted_unit_price::float AS accepted_unit_price
    FROM vendor_bid_lines
    WHERE bid_id IN (SELECT id FROM vendor_bids WHERE vendor_link_id = ${link.id})
    ORDER BY position
  `;
  return c.json({
    bids: bids.map(b => ({
      id: b.id, contactName: b.contact_name, note: b.note,
      status: b.status, createdAt: b.created_at,
      lines: lines.filter(l => l.bid_id === b.id).map(l => ({
        label: l.label, offeredQty: l.offered_qty, offeredUnitPrice: l.offered_unit_price,
        status: l.line_status, acceptedQty: l.accepted_qty, acceptedUnitPrice: l.accepted_unit_price,
      })),
    })),
  });
});

export default vendorPublic;
