// Prepaid shipping labels on purchase orders: /api/orders/:orderId/shipments.
// Mounted as a second sub-app on the orders prefix (orders.ts is big enough);
// authMiddleware and csrfGuard already cover /api/orders/*.
//
// Money flow: buying a label adds its price to orders.other_fees (the existing
// fee stack that po-cost.ts amortizes into profit/commission); a successful
// void subtracts it back. The shipment row's label_cost + fees_applied latch
// make both moves idempotent.

import { Hono } from 'hono';
import type { Env, User } from '../types';
import { getDb } from '../db';
import { uploadAttachment } from '../r2';
import { writeOrderEvent } from '../services/orderAudit';
import { FEE_NOTE_MAX, voidShipmentTx } from '../services/shipmentVoid';
import { notifyManagers } from '../lib/notify';
import { effectiveRole } from '../lib/role';
import { pickShippingClient, carrierTrackingUrl } from '../shipping';
import type { RateQuote, ShipAddress, ShipPackage, ShipmentStatus } from '../shipping';
import { canTransition } from '../shipping/status';

const shipments = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type OrderRow = { id: string; user_id: string; lifecycle: string; warehouse_id: string | null };

export type ShipmentRow = {
  id: string;
  order_id: string;
  status: ShipmentStatus;
  // Nullable since 0093: a seller-fill shell starts empty. rates/buy enforce
  // completeness.
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
  carrier: string | null;
  service: string | null;
  rate_amount: number | null;
  rate_currency: string;
  delivery_days: number | null;
  provider: string;
  provider_shipment_id?: string | null;
  quotes?: RateQuote[] | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_delivery_url: string | null;
  label_cost: number | null;
  fees_applied: boolean;
  tracking_status: string | null;
  tracking_eta: Date | null;
  last_tracked_at: Date | null;
  seller_token: string | null;
  created_by: string | null;
  created_at: Date;
};

export function shipmentComplete(r: Pick<ShipmentRow,
  'from_name' | 'from_street1' | 'from_city' | 'from_state' | 'from_zip'
  | 'weight_oz' | 'length_in' | 'width_in' | 'height_in'>): boolean {
  return !!(r.from_name && r.from_street1 && r.from_city && r.from_state && r.from_zip
    && r.weight_oz && r.length_in && r.width_in && r.height_in);
}

// One authoritative column list. The per-order routes render it bare via
// SHIPMENT_COLS; the cross-PO list (shipmentsGlobal.ts) renders it prefixed
// and without the heavy `quotes` JSONB / provider_shipment_id it never reads.
const SHIPMENT_COL_NAMES = [
  'id', 'order_id', 'status',
  'from_name', 'from_phone', 'from_street1', 'from_street2',
  'from_city', 'from_state', 'from_zip', 'from_country',
  'weight_oz', 'length_in', 'width_in', 'height_in',
  'carrier', 'service', 'rate_amount', 'rate_currency', 'delivery_days',
  'provider', 'provider_shipment_id', 'quotes',
  'tracking_number', 'tracking_url', 'label_delivery_url',
  'label_cost', 'fees_applied',
  'tracking_status', 'tracking_eta', 'last_tracked_at',
  'seller_token', 'created_by', 'created_at',
] as const;
const FLOAT_COLS: ReadonlySet<string> =
  new Set(['weight_oz', 'length_in', 'width_in', 'height_in', 'rate_amount', 'label_cost']);

/** Static column list for interpolation via sql.unsafe — no runtime input. */
export function shipmentColsSql(prefix = '', omit: ReadonlySet<string> = new Set()): string {
  return SHIPMENT_COL_NAMES
    .filter((c) => !omit.has(c))
    .map((c) => (FLOAT_COLS.has(c) ? `${prefix}${c}::float AS ${c}` : `${prefix}${c}`))
    .join(', ');
}

const SHIPMENT_COLS = (sql: ReturnType<typeof getDb>) => sql.unsafe(shipmentColsSql());

export function toApi(r: ShipmentRow) {
  return {
    id: r.id,
    orderId: r.order_id,
    status: r.status,
    from: {
      name: r.from_name,
      phone: r.from_phone,
      street1: r.from_street1,
      street2: r.from_street2,
      city: r.from_city,
      state: r.from_state,
      zip: r.from_zip,
      country: r.from_country,
    },
    package: {
      weightOz: r.weight_oz,
      lengthIn: r.length_in,
      widthIn: r.width_in,
      heightIn: r.height_in,
    },
    carrier: r.carrier,
    service: r.service,
    rateAmount: r.rate_amount,
    rateCurrency: r.rate_currency,
    deliveryDays: r.delivery_days,
    provider: r.provider,
    trackingNumber: r.tracking_number,
    trackingUrl: r.tracking_url,
    labelUrl: r.label_delivery_url,
    labelCost: r.label_cost,
    trackingStatus: r.tracking_status,
    trackingEta: r.tracking_eta,
    lastTrackedAt: r.last_tracked_at,
    sellerToken: r.seller_token,
    complete: shipmentComplete(r),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

async function loadOrder(sql: ReturnType<typeof getDb>, orderId: string): Promise<OrderRow | undefined> {
  return (await sql`
    SELECT id, user_id, lifecycle, warehouse_id FROM orders WHERE id = ${orderId} LIMIT 1
  `)[0] as OrderRow | undefined;
}

// Mutations mirror PO edit gating: the order's owner or a manager.
function canMutate(u: User, order: OrderRow): boolean {
  return u.role === 'manager' || order.user_id === u.id;
}

type FromInput = Partial<Record<keyof ShipAddress, unknown>>;
type PkgInput = Partial<Record<keyof ShipPackage, unknown>>;

// Exported for the public seller-fill route, which accepts the same shapes.
export function parseFrom(raw: unknown): ShipAddress | string {
  const f = (raw ?? {}) as FromInput;
  const req = (v: unknown, label: string): string | { v: string } => {
    if (typeof v !== 'string' || !v.trim()) return `${label} is required`;
    return { v: v.trim() };
  };
  const name = req(f.name, 'seller name');
  const street1 = req(f.street1, 'street');
  const city = req(f.city, 'city');
  const state = req(f.state, 'state');
  const zip = req(f.zip, 'ZIP');
  for (const r of [name, street1, city, state, zip]) if (typeof r === 'string') return r;
  const opt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    name: (name as { v: string }).v,
    phone: opt(f.phone),
    street1: (street1 as { v: string }).v,
    street2: opt(f.street2),
    city: (city as { v: string }).v,
    state: (state as { v: string }).v,
    zip: (zip as { v: string }).v,
    country: opt(f.country)?.toUpperCase() ?? 'US',
  };
}

export function parsePackage(raw: unknown): ShipPackage | string {
  const p = (raw ?? {}) as PkgInput;
  const dims: [keyof ShipPackage, string][] = [
    ['weightOz', 'weight'],
    ['lengthIn', 'length'],
    ['widthIn', 'width'],
    ['heightIn', 'height'],
  ];
  const out = {} as ShipPackage;
  for (const [key, label] of dims) {
    const n = typeof p[key] === 'string' ? Number(p[key]) : p[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      return `${label} must be a positive number`;
    }
    out[key] = n;
  }
  return out;
}

type WarehouseAddr = {
  name: string | null;
  ship_contact_name: string | null;
  ship_phone: string | null;
  ship_street1: string | null;
  ship_street2: string | null;
  ship_city: string | null;
  ship_state: string | null;
  ship_zip: string | null;
  ship_country: string | null;
};

// A warehouse is shippable when street1/city/state/zip are all present.
async function loadWarehouseShipTo(
  sql: ReturnType<typeof getDb>,
  warehouseId: string | null,
): Promise<{ addr: ShipAddress; warehouseName: string } | { error: string }> {
  if (!warehouseId) return { error: 'This order has no warehouse — set one before buying a label' };
  const w = (await sql`
    SELECT name, ship_contact_name, ship_phone, ship_street1, ship_street2,
           ship_city, ship_state, ship_zip, ship_country
    FROM warehouses WHERE id = ${warehouseId} LIMIT 1
  `)[0] as WarehouseAddr | undefined;
  const label = w?.name ?? warehouseId;
  if (!w || !w.ship_street1 || !w.ship_city || !w.ship_state || !w.ship_zip) {
    return { error: `${label} has no shipping address — add it in Settings → Warehouses` };
  }
  return {
    warehouseName: label,
    addr: {
      name: w.ship_contact_name ?? label,
      phone: w.ship_phone,
      street1: w.ship_street1,
      street2: w.ship_street2,
      city: w.ship_city,
      state: w.ship_state,
      zip: w.ship_zip,
      country: w.ship_country ?? 'US',
    },
  };
}

// URL-safe unguessable token, same recipe as vendor links (customers.ts).
function newSellerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── List ─────────────────────────────────────────────────────────────────────
shipments.get('/:orderId/shipments', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  // Same scope as GET /api/orders/:id — a shipment row carries the seller's
  // address and the PO's fee trail, not something every purchaser should read.
  if (effectiveRole(u) !== 'manager' && order.user_id !== u.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const rows = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments
    WHERE order_id = ${orderId}
    ORDER BY created_at ASC
  `) as unknown as ShipmentRow[];
  return c.json({ items: rows.map(toApi) });
});

// ── Create draft ─────────────────────────────────────────────────────────────
shipments.post('/:orderId/shipments', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, order)) return c.json({ error: 'Forbidden' }, 403);
  if (order.lifecycle === 'done') return c.json({ error: 'Order is done — its book is closed' }, 409);

  const body = (await c.req.json().catch(() => null)) as
    | { from?: unknown; package?: unknown; sellerFill?: boolean }
    | null;

  // sellerFill: create an empty shell whose address/package the seller enters
  // via the tokenized public link. Otherwise the purchaser supplies both.
  const sellerFill = body?.sellerFill === true;
  let from: ShipAddress | null = null;
  let pkg: ShipPackage | null = null;
  if (!sellerFill) {
    const f = parseFrom(body?.from);
    if (typeof f === 'string') return c.json({ error: f }, 400);
    const p = parsePackage(body?.package);
    if (typeof p === 'string') return c.json({ error: p }, 400);
    from = f;
    pkg = p;
  }

  const provider = pickShippingClient(c.env).provider;
  const sellerToken = sellerFill ? newSellerToken() : null;
  const row = await sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO shipments (
        order_id, status,
        from_name, from_phone, from_street1, from_street2,
        from_city, from_state, from_zip, from_country,
        weight_oz, length_in, width_in, height_in,
        provider, seller_token, created_by
      ) VALUES (
        ${orderId}, 'draft',
        ${from?.name ?? null}, ${from?.phone ?? null}, ${from?.street1 ?? null}, ${from?.street2 ?? null},
        ${from?.city ?? null}, ${from?.state ?? null}, ${from?.zip ?? null}, ${from?.country ?? null},
        ${pkg?.weightOz ?? null}, ${pkg?.lengthIn ?? null}, ${pkg?.widthIn ?? null}, ${pkg?.heightIn ?? null},
        ${provider}, ${sellerToken}, ${u.id}
      )
      RETURNING id
    `;
    await writeOrderEvent(tx, orderId, u.id, 'shipment_created', {
      shipmentId: inserted[0].id,
      ...(sellerFill ? { sellerFill: true } : {}),
    });
    return inserted[0];
  });

  const full = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments WHERE id = ${row.id} LIMIT 1
  `) as unknown as ShipmentRow[];
  return c.json({ shipment: toApi(full[0]) }, 201);
});

// ── Seller link: (re)issue the public fill token ─────────────────────────────
shipments.post('/:orderId/shipments/:sid/seller-link', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const sid = c.req.param('sid');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const token = newSellerToken();
  const updated = await sql<{ id: string }[]>`
    UPDATE shipments SET seller_token = ${token}
    WHERE id = ${sid} AND order_id = ${orderId} AND status IN ('draft','quoted')
    RETURNING id
  `;
  if (!updated.length) return c.json({ error: 'Seller links only apply before a label is bought' }, 409);
  return c.json({ sellerToken: token });
});

// ── Edit address / package (draft|quoted; editing invalidates quotes) ────────
shipments.patch('/:orderId/shipments/:sid', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const sid = c.req.param('sid');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as { from?: unknown; package?: unknown } | null;
  const from = parseFrom(body?.from);
  if (typeof from === 'string') return c.json({ error: from }, 400);
  const pkg = parsePackage(body?.package);
  if (typeof pkg === 'string') return c.json({ error: pkg }, 400);

  const updated = await sql<{ id: string }[]>`
    UPDATE shipments SET
      from_name = ${from.name}, from_phone = ${from.phone},
      from_street1 = ${from.street1}, from_street2 = ${from.street2},
      from_city = ${from.city}, from_state = ${from.state},
      from_zip = ${from.zip}, from_country = ${from.country},
      weight_oz = ${pkg.weightOz}, length_in = ${pkg.lengthIn},
      width_in = ${pkg.widthIn}, height_in = ${pkg.heightIn},
      status = 'draft'
    WHERE id = ${sid} AND order_id = ${orderId} AND status IN ('draft','quoted')
    RETURNING id
  `;
  if (!updated.length) return c.json({ error: 'Shipment can no longer be edited' }, 409);

  const full = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments WHERE id = ${sid} LIMIT 1
  `) as unknown as ShipmentRow[];
  return c.json({ shipment: toApi(full[0]) });
});

// ── Rates ────────────────────────────────────────────────────────────────────
shipments.post('/:orderId/shipments/:sid/rates', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const sid = c.req.param('sid');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const shipment = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments WHERE id = ${sid} AND order_id = ${orderId} LIMIT 1
  `)[0] as ShipmentRow | undefined;
  if (!shipment) return c.json({ error: 'Not found' }, 404);
  if (!canTransition(shipment.status, 'quoted')) {
    return c.json({ error: 'Rates can only be fetched for a draft shipment' }, 409);
  }
  if (!shipmentComplete(shipment)) {
    return c.json({ error: "Waiting for the seller's address and box size — share the seller link or fill them in" }, 409);
  }

  const shipTo = await loadWarehouseShipTo(sql, order.warehouse_id);
  if ('error' in shipTo) return c.json({ error: shipTo.error }, 409);

  const client = pickShippingClient(c.env);
  let rates: RateQuote[];
  try {
    rates = await client.listRates(
      {
        name: shipment.from_name!,
        phone: shipment.from_phone,
        street1: shipment.from_street1!,
        street2: shipment.from_street2,
        city: shipment.from_city!,
        state: shipment.from_state!,
        zip: shipment.from_zip!,
        country: shipment.from_country ?? 'US',
      },
      shipTo.addr,
      {
        weightOz: shipment.weight_oz!,
        lengthIn: shipment.length_in!,
        widthIn: shipment.width_in!,
        heightIn: shipment.height_in!,
      },
    );
  } catch (err) {
    console.error('[shipping] rate fetch failed', err);
    return c.json({ error: 'The shipping provider could not return rates — try again' }, 502);
  }

  // The buy handler resolves the picked rate_id against these stored quotes —
  // the provider's buy response doesn't echo carrier/service, and a rate_id
  // from another shipment must not be replayable here.
  await sql`
    UPDATE shipments SET status = 'quoted', quotes = ${sql.json(rates as never)}
    WHERE id = ${sid} AND status IN ('draft','quoted')
  `;
  // The provider rides on the response, not on each RateQuote: one call is one
  // client, and the wizard needs it to mark demo rates *before* the buy. Adding
  // it to RateQuote would also change the shape stored in `quotes`.
  return c.json({ rates, provider: client.provider });
});

// ── Buy ──────────────────────────────────────────────────────────────────────
shipments.post('/:orderId/shipments/:sid/buy', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const sid = c.req.param('sid');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, order)) return c.json({ error: 'Forbidden' }, 403);
  if (order.lifecycle === 'done') return c.json({ error: 'Order is done — its book is closed' }, 409);

  const body = (await c.req.json().catch(() => null)) as
    | { rateId?: string; expectedAmount?: number }
    | null;
  if (!body?.rateId || typeof body.rateId !== 'string') {
    return c.json({ error: 'rateId is required' }, 400);
  }
  // Bound to a plain const: property narrowing doesn't survive into the
  // sql.begin closure below.
  const rateId = body.rateId;

  const shipment = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments WHERE id = ${sid} AND order_id = ${orderId} LIMIT 1
  `)[0] as ShipmentRow | undefined;
  if (!shipment) return c.json({ error: 'Not found' }, 404);
  if (!canTransition(shipment.status, 'purchased')) {
    return c.json({ error: 'Fetch rates before buying a label' }, 409);
  }
  if (!shipmentComplete(shipment)) {
    return c.json({ error: "Waiting for the seller's address and box size — share the seller link or fill them in" }, 409);
  }

  const shipTo = await loadWarehouseShipTo(sql, order.warehouse_id);
  if ('error' in shipTo) return c.json({ error: shipTo.error }, 409);

  // The rate must be one this shipment was quoted: the provider's buy
  // response doesn't echo carrier/service (the quote carries them), and a
  // rate_id minted for another shipment must not be replayable here.
  const quote = (shipment.quotes ?? []).find((q) => q.rateId === rateId) ?? null;
  if (!quote) return c.json({ error: 'That rate is no longer available — refresh rates' }, 409);

  // Charge → upload → record, in that order: the two non-transactional steps
  // come first, and once money has moved nothing below is allowed to turn the
  // response into an error the client would retry into a double-charge.
  // The shipment id doubles as the provider-side idempotency key
  // (platform_uk_id): a retried purchase returns the existing label.
  const client = pickShippingClient(c.env);
  let label;
  try {
    label = await client.buyByRateId(rateId, { platformUkId: sid, quote });
  } catch (err) {
    console.error('[shipping] label purchase failed', err);
    return c.json({ error: 'The shipping provider rejected the purchase — refresh rates and try again' }, 502);
  }

  const amountChanged =
    typeof body.expectedAmount === 'number' && Math.abs(body.expectedAmount - label.amount) > 0.01;

  // A stub label is a demo: no carrier was paid, so its price must not reach
  // the books. label_cost stays NULL alongside fees_applied = FALSE — the two
  // are read together (voidShipmentTx's reversal, and the cost tape's
  // shipping-vs-other split), and a cost with no fee behind it misattributes
  // a real fee as shipping.
  const demo = client.provider === 'stub';

  let upload;
  try {
    upload = await uploadAttachment(
      c.env,
      new File([label.labelData as Uint8Array<ArrayBuffer>], `label-${label.trackingNumber}.${label.labelExt}`, {
        type: label.labelContentType,
      }),
      `orders/${orderId}/shipments`,
    );
  } catch (err) {
    // Label bought but not stored: keep going with no stored PDF rather than
    // strand the charge; the tracking number is still recorded.
    console.error(`[shipping] label ${label.trackingNumber} purchased but upload failed`, err);
    upload = null;
  }

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`;
      await tx`
        UPDATE shipments SET
          status = 'purchased',
          to_name = ${shipTo.addr.name}, to_phone = ${shipTo.addr.phone},
          to_street1 = ${shipTo.addr.street1}, to_street2 = ${shipTo.addr.street2},
          to_city = ${shipTo.addr.city}, to_state = ${shipTo.addr.state},
          to_zip = ${shipTo.addr.zip}, to_country = ${shipTo.addr.country},
          carrier = ${label.carrier}, service = ${label.service},
          rate_amount = ${label.amount}, rate_currency = ${label.currency},
          -- Re-stamp: the draft was stamped with whatever client was configured
          -- at creation; a draft born under the stub and bought after real
          -- credentials arrived must not stay provider='stub', or the tracking
          -- poll (which filters on provider) skips this real label forever.
          provider = ${client.provider},
          provider_rate_id = ${rateId}, provider_shipment_id = ${label.shipmentId},
          tracking_number = ${label.trackingNumber},
          tracking_url = ${label.trackingUrl ?? carrierTrackingUrl(label.carrier, label.trackingNumber)},
          label_storage_key = ${upload?.storageKey ?? null},
          label_delivery_url = ${upload?.deliveryUrl ?? null},
          label_cost = ${demo ? null : label.amount},
          fees_applied = ${!demo},
          tracking_status = 'purchased'
        WHERE id = ${sid}
      `;
      if (!demo) {
        await tx`
          UPDATE orders SET
            other_fees = other_fees + ${label.amount},
            other_fees_note = left(
              concat_ws(' | ', nullif(other_fees_note, ''), ${'Shipping label ' + label.trackingNumber}::text),
              ${FEE_NOTE_MAX}::int
            )
          WHERE id = ${orderId}
        `;
      }
      await writeOrderEvent(tx, orderId, u.id, 'shipment_purchased', {
        shipmentId: sid,
        carrier: label.carrier,
        service: label.service,
        amount: label.amount,
        trackingNumber: label.trackingNumber,
        ...(demo && { demo: true }),
      });
      await notifyManagers(tx, {
        kind: 'shipment_purchased',
        tone: 'info',
        icon: 'package',
        title: `Shipping label bought for ${orderId}`,
        body: demo
          ? `${u.name} bought a demo ${label.carrier} ${label.service} label — no charge, nothing added to the PO`
          : `${u.name} bought ${label.carrier} ${label.service} — $${label.amount.toFixed(2)}`,
      });
    });
  } catch (err) {
    console.error(
      `[shipping] label ${label.trackingNumber} PURCHASED but recording failed — reconcile against ShipSaving manually`,
      err,
    );
    throw err;
  }

  const full = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments WHERE id = ${sid} LIMIT 1
  `) as unknown as ShipmentRow[];
  return c.json({ shipment: toApi(full[0]), amountChanged });
});

// ── Void ─────────────────────────────────────────────────────────────────────
shipments.post('/:orderId/shipments/:sid/void', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const sid = c.req.param('sid');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, order)) return c.json({ error: 'Forbidden' }, 403);
  if (order.lifecycle === 'done') return c.json({ error: 'Order is done — its book is closed' }, 409);

  const shipment = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments WHERE id = ${sid} AND order_id = ${orderId} LIMIT 1
  `)[0] as ShipmentRow | undefined;
  if (!shipment) return c.json({ error: 'Not found' }, 404);
  if (!canTransition(shipment.status, 'voided') || !shipment.tracking_number) {
    return c.json({ error: 'Only a purchased label can be voided' }, 409);
  }

  const client = pickShippingClient(c.env);
  const result = await client.voidLabel({
    shipmentNo: shipment.provider_shipment_id ?? null,
    platformUkId: sid,
  });
  if (!result.ok) {
    return c.json({ error: result.message ?? 'The carrier refused to void this label' }, 409);
  }

  await sql.begin(async (tx) =>
    voidShipmentTx(tx, {
      orderId,
      sid,
      trackingNumber: shipment.tracking_number,
      carrier: shipment.carrier,
      actor: { id: u.id, name: u.name },
    }));

  const full = (await sql`
    SELECT ${SHIPMENT_COLS(sql)} FROM shipments WHERE id = ${sid} LIMIT 1
  `) as unknown as ShipmentRow[];
  return c.json({ shipment: toApi(full[0]) });
});

// ── Delete (never after money moved) ─────────────────────────────────────────
shipments.delete('/:orderId/shipments/:sid', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const sid = c.req.param('sid');
  const order = await loadOrder(sql, orderId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const deleted = await sql<{ id: string }[]>`
    DELETE FROM shipments
    WHERE id = ${sid} AND order_id = ${orderId} AND status IN ('draft','quoted')
    RETURNING id
  `;
  if (!deleted.length) return c.json({ error: 'This label was bought — void it instead' }, 409);
  return c.json({ ok: true });
});

export default shipments;
