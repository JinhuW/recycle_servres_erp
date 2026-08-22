// Standalone tracked packages (/api/packages): external labels with no PO
// behind them yet. The agreed flow is "standalone package, PO on delivery" —
// the draft PO is minted by create-po once the box arrives, and the tracking
// poll (shipping/track.ts) moves these rows exactly like shipments.

import { Hono } from 'hono';
import type { Env, User } from '../types';
import { getDb } from '../db';
import { effectiveRole } from '../lib/role';
import { nextHumanId } from '../lib/id-seq';
import { writeOrderEvent } from '../services/orderAudit';

const packages = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const CARRIERS = ['UPS', 'FedEx', 'USPS'] as const;
type Carrier = (typeof CARRIERS)[number];

// The tracked subset of the shipment vocabulary — enforced by the table CHECK.
type PackageStatus = 'purchased' | 'in_transit' | 'delivered' | 'exception';

type PackageRow = {
  id: string;
  tracking_number: string;
  carrier: Carrier;
  status: PackageStatus;
  tracking_status: string | null;
  tracking_eta: Date | null;
  last_tracked_at: Date | null;
  seller_name: string | null;
  note: string | null;
  order_id: string | null;
  created_by: string | null;
  created_at: Date;
};

const PACKAGE_COLS = (sql: ReturnType<typeof getDb>) => sql`
  id, tracking_number, carrier, status, tracking_status, tracking_eta,
  last_tracked_at, seller_name, note, order_id, created_by, created_at
`;

function toApi(r: PackageRow) {
  return {
    id: r.id,
    trackingNumber: r.tracking_number,
    carrier: r.carrier,
    status: r.status,
    trackingEta: r.tracking_eta,
    lastTrackedAt: r.last_tracked_at,
    sellerName: r.seller_name,
    note: r.note,
    orderId: r.order_id,
    createdAt: r.created_at,
  };
}

// Same predicate as shipments: the row's creator or a manager.
function canMutate(u: User, row: PackageRow): boolean {
  return u.role === 'manager' || row.created_by === u.id;
}

// ── List ─────────────────────────────────────────────────────────────────────
packages.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const scopeFrag = effectiveRole(u) === 'manager' ? sql`TRUE` : sql`created_by = ${u.id}`;
  const rows = (await sql`
    SELECT ${PACKAGE_COLS(sql)} FROM packages
    WHERE ${scopeFrag}
    ORDER BY created_at DESC
  `) as unknown as PackageRow[];
  return c.json({ items: rows.map(toApi) });
});

// ── Add ──────────────────────────────────────────────────────────────────────
packages.post('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | { trackingNumber?: unknown; carrier?: unknown; sellerName?: unknown; note?: unknown }
    | null;

  const trackingNumber = typeof body?.trackingNumber === 'string' ? body.trackingNumber.trim() : '';
  if (trackingNumber.length < 8) return c.json({ error: 'A tracking number is required' }, 400);
  if (!CARRIERS.includes(body?.carrier as Carrier)) {
    return c.json({ error: 'carrier must be UPS, FedEx, or USPS' }, 400);
  }
  const opt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  // ON CONFLICT instead of a pre-check so two concurrent pastes of the same
  // number can't both slip past a SELECT.
  const inserted = (await sql`
    INSERT INTO packages (tracking_number, carrier, seller_name, note, created_by)
    VALUES (${trackingNumber}, ${body!.carrier as Carrier}, ${opt(body?.sellerName)}, ${opt(body?.note)}, ${u.id})
    ON CONFLICT (tracking_number) DO NOTHING
    RETURNING ${PACKAGE_COLS(sql)}
  `) as unknown as PackageRow[];
  if (!inserted.length) {
    return c.json({ error: 'This tracking number is already being tracked' }, 409);
  }
  return c.json({ package: toApi(inserted[0]) }, 201);
});

// ── Create the PO the delivered box becomes ──────────────────────────────────
packages.post('/:id/create-po', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const id = c.req.param('id');

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'forbidden' }
    | { kind: 'linked'; orderId: string }
    | { kind: 'notDelivered' }
    | { kind: 'ok'; orderId: string };

  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const row = (await tx`
      SELECT ${PACKAGE_COLS(tx as unknown as ReturnType<typeof getDb>)}
      FROM packages WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as PackageRow | undefined;
    if (!row) return { kind: 'notFound' };
    if (!canMutate(u, row)) return { kind: 'forbidden' };
    if (row.order_id) return { kind: 'linked', orderId: row.order_id };
    // The agreed flow is PO-on-delivery; the button only shows then, and the
    // server holds the same line.
    if (row.status !== 'delivered') return { kind: 'notDelivered' };

    const orderId = await nextHumanId(tx, 'PO', 'PO');
    const notes = ['Created from delivered package', row.carrier, row.tracking_number, row.seller_name]
      .filter(Boolean).join(' · ');
    await tx`
      INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle)
      VALUES (${orderId}, ${u.id}, 'Mixed', ${null}, 'company', ${notes}, ${null}, 'draft')
    `;
    await writeOrderEvent(tx, orderId, u.id, 'created', {
      categories: [],
      lineCount: 0,
      qty: 0,
      totalCost: null,
    });
    await tx`UPDATE packages SET order_id = ${orderId} WHERE id = ${id}`;
    return { kind: 'ok', orderId };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  if (outcome.kind === 'linked') {
    return c.json({ error: `Already linked to ${outcome.orderId}` }, 409);
  }
  if (outcome.kind === 'notDelivered') {
    return c.json({ error: 'The purchase order is created when the package is delivered' }, 409);
  }
  return c.json({ orderId: outcome.orderId }, 201);
});

// ── Remove (only while standalone) ───────────────────────────────────────────
packages.delete('/:id', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const id = c.req.param('id');

  const row = (await sql`
    SELECT ${PACKAGE_COLS(sql)} FROM packages WHERE id = ${id} LIMIT 1
  `)[0] as PackageRow | undefined;
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (!canMutate(u, row)) return c.json({ error: 'Forbidden' }, 403);
  if (row.order_id) return c.json({ error: 'This package already has a purchase order' }, 409);

  await sql`DELETE FROM packages WHERE id = ${id} AND order_id IS NULL`;
  return c.json({ ok: true });
});

export default packages;
