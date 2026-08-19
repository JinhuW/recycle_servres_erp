// Unauthenticated seller-fill endpoints for prepaid labels, mounted at
// /api/public/shipping/:token (CSRF-exempt like the rest of /api/public/*,
// see csrf.ts — the token in the URL is the credential, vendor-portal style).
//
// The seller sees and touches only their own shipment's address and package.
// Any token miss — unknown, or a shipment already past quoted — answers a
// uniform 404 so the endpoint never reveals whether a token exists.

import { Hono } from 'hono';
import type { Env, User } from '../types';
import { getDb } from '../db';
import { notify } from '../lib/notify';
import { writeOrderEvent } from '../services/orderAudit';
import { parseFrom, parsePackage, shipmentComplete } from './shipments';

const shippingPublic = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type FillRow = {
  id: string;
  order_id: string;
  status: string;
  from_name: string | null;
  from_phone: string | null;
  from_street1: string | null;
  from_street2: string | null;
  from_city: string | null;
  from_state: string | null;
  from_zip: string | null;
  from_country: string | null;
  weight_oz: number | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  owner_id: string;
  to_label: string | null;
};

async function loadByToken(sql: ReturnType<typeof getDb>, token: string): Promise<FillRow | null> {
  if (!token) return null;
  const rows = await sql`
    SELECT s.id, s.order_id, s.status,
           s.from_name, s.from_phone, s.from_street1, s.from_street2,
           s.from_city, s.from_state, s.from_zip, s.from_country,
           s.weight_oz::float AS weight_oz, s.length_in::float AS length_in,
           s.width_in::float AS width_in, s.height_in::float AS height_in,
           o.user_id AS owner_id,
           w.name AS to_label
    FROM shipments s
    JOIN orders o ON o.id = s.order_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE s.seller_token = ${token} AND s.status IN ('draft','quoted')
    LIMIT 1
  `;
  return (rows[0] as FillRow) ?? null;
}

// What the seller sees: their own entries plus the destination's display name.
// No order id, no prices, no inventory.
shippingPublic.get('/:token', async (c) => {
  const sql = getDb(c.env);
  const row = await loadByToken(sql, c.req.param('token'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({
    destination: row.to_label,
    submitted: shipmentComplete(row as Parameters<typeof shipmentComplete>[0]),
    from: {
      name: row.from_name, phone: row.from_phone,
      street1: row.from_street1, street2: row.from_street2,
      city: row.from_city, state: row.from_state,
      zip: row.from_zip, country: row.from_country,
    },
    package: {
      weightOz: row.weight_oz, lengthIn: row.length_in,
      widthIn: row.width_in, heightIn: row.height_in,
    },
  });
});

shippingPublic.post('/:token', async (c) => {
  const sql = getDb(c.env);
  const row = await loadByToken(sql, c.req.param('token'));
  if (!row) return c.json({ error: 'Not found' }, 404);

  const body = (await c.req.json().catch(() => null)) as { from?: unknown; package?: unknown } | null;
  const from = parseFrom(body?.from);
  if (typeof from === 'string') return c.json({ error: from }, 400);
  const pkg = parsePackage(body?.package);
  if (typeof pkg === 'string') return c.json({ error: pkg }, 400);

  await sql.begin(async (tx) => {
    // Reset to draft: a seller edit invalidates any quotes the purchaser saw.
    await tx`
      UPDATE shipments SET
        from_name = ${from.name}, from_phone = ${from.phone},
        from_street1 = ${from.street1}, from_street2 = ${from.street2},
        from_city = ${from.city}, from_state = ${from.state},
        from_zip = ${from.zip}, from_country = ${from.country},
        weight_oz = ${pkg.weightOz}, length_in = ${pkg.lengthIn},
        width_in = ${pkg.widthIn}, height_in = ${pkg.heightIn},
        status = 'draft'
      WHERE id = ${row.id}
    `;
    await writeOrderEvent(tx, row.order_id, null, 'shipment_seller_filled', {
      shipmentId: row.id,
      sellerName: from.name,
      city: from.city,
      state: from.state,
    });
    await notify(tx, {
      userId: row.owner_id,
      kind: 'shipment_seller_filled',
      tone: 'pos',
      icon: 'package',
      title: `${from.name} filled in their shipping details`,
      body: `${row.order_id} — ready to compare rates and buy the label`,
    });
  });

  return c.json({ ok: true });
});

export default shippingPublic;
