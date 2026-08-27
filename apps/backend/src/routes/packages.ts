// Standalone tracked packages (/api/packages): external labels with no PO
// behind them yet. The agreed flow is "standalone package, PO on delivery" —
// the draft PO is minted by create-po once the box arrives, and the tracking
// poll (shipping/track.ts) moves these rows exactly like shipments.

import { Hono } from 'hono';
import {
  CARRIERS, PACKAGE_SOURCES, isValidTracking, normalizeTracking,
  type Carrier, type PackageSource,
} from '@recycle-erp/shared';
import type { Env, User } from '../types';
import { getDb } from '../db';
import { effectiveRole } from '../lib/role';
import { insertDraftOrderTx } from '../services/orderDraft';
import { carrierTrackingUrl } from '../shipping';

const packages = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// The tracked subset of the shipment vocabulary — enforced by the table CHECK.
type PackageStatus = 'purchased' | 'in_transit' | 'delivered' | 'exception';

const SOURCES = new Set<string>(PACKAGE_SOURCES);

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
  source: PackageSource | null;
  paypal_txn_id: string | null;
  payment_screenshot_key: string | null;
  payment_screenshot_url: string | null;
  order_id: string | null;
  created_by: string | null;
  created_at: Date;
};

const PACKAGE_COLS = (sql: ReturnType<typeof getDb>) => sql`
  id, tracking_number, carrier, status, tracking_status, tracking_eta,
  last_tracked_at, seller_name, note, source, paypal_txn_id, payment_screenshot_key,
  payment_screenshot_url, order_id, created_by, created_at
`;

function toApi(r: PackageRow, creatorName: string | null) {
  return {
    id: r.id,
    trackingNumber: r.tracking_number,
    carrier: r.carrier,
    status: r.status,
    trackingEta: r.tracking_eta,
    lastTrackedAt: r.last_tracked_at,
    sellerName: r.seller_name,
    note: r.note,
    source: r.source,
    paypalTxnId: r.paypal_txn_id,
    // The R2 key stays internal; clients only ever need the public URL.
    paymentScreenshotUrl: r.payment_screenshot_url,
    orderId: r.order_id,
    // Server-built like shipments.tracking_url, so the carrier→URL table
    // lives once (shipping/types.ts) instead of per client.
    trackingUrl: carrierTrackingUrl(r.carrier, r.tracking_number),
    // Who tracked the box — the shipping table's answer to "whose is this?",
    // the same question order.userName answers for a shipment row.
    creatorName,
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
  // `mine` pins a manager to their own rows, mirroring GET /api/shipments —
  // without it the desktop Mine scope and the phone's personal glance would
  // narrow shipments but still merge in everyone's packages.
  const mineOnly = c.req.query('mine') === 'true';
  const scopeFrag = effectiveRole(u) === 'manager' && !mineOnly ? sql`TRUE` : sql`created_by = ${u.id}`;
  const rows = (await sql`
    SELECT ${PACKAGE_COLS(sql)},
           (SELECT name FROM users us WHERE us.id = created_by) AS creator_name
    FROM packages
    WHERE ${scopeFrag}
    ORDER BY created_at DESC
  `) as unknown as (PackageRow & { creator_name: string | null })[];
  return c.json({ items: rows.map(r => toApi(r, r.creator_name)) });
});

// ── Lookup by scanned barcode ────────────────────────────────────────────────
packages.get('/lookup', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const code = normalizeTracking(c.req.query('code') ?? '');
  if (code.length < 8 || code.length > 64) {
    return c.json({ error: 'A scanned barcode is required' }, 400);
  }
  // No `mine` here: the point is a manager scanning any box in the receiving
  // pile, whoever tracked it. Purchasers stay pinned to their own rows.
  const scopeFrag = effectiveRole(u) === 'manager' ? sql`TRUE` : sql`created_by = ${u.id}`;
  // Carrier barcodes wrap the tracking number — USPS IMpb prefixes 420+ZIP,
  // FedEx 96 barcodes run ~34 digits ending in the number, UPS 1Z is verbatim —
  // so fall back to "scan ends with the stored number". right(), not LIKE:
  // a stored number holding %/_/\ (rows predate boundary validation) must
  // match literally, never as a pattern. Seq scan by design: this table is
  // one row per inbound box, tens of rows.
  const rows = (await sql`
    SELECT ${PACKAGE_COLS(sql)},
           (SELECT name FROM users us WHERE us.id = created_by) AS creator_name
    FROM packages
    WHERE ${scopeFrag}
      AND (tracking_number = ${code} OR right(${code}, length(tracking_number)) = tracking_number)
    ORDER BY (tracking_number = ${code}) DESC, length(tracking_number) DESC
    LIMIT 1
  `) as unknown as (PackageRow & { creator_name: string | null })[];
  // A miss is a normal outcome (a box nobody tracked yet), and a purchaser
  // must not learn that someone else's number exists — both come back null.
  return c.json({
    package: rows.length ? toApi(rows[0], rows[0].creator_name) : null,
  });
});

// ── Add ──────────────────────────────────────────────────────────────────────
packages.post('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | {
        trackingNumber?: unknown; carrier?: unknown; sellerName?: unknown; note?: unknown;
        source?: unknown;
        paypalTxnId?: unknown; paymentScreenshotKey?: unknown; paymentScreenshotUrl?: unknown;
      }
    | null;

  // Normalized at the boundary, not trusted from the client: the unique index
  // is what guarantees one row per physical box, and '1z 999…' vs
  // '1Z999…' must collide there, not mint two rows that both grow a PO.
  const trackingNumber =
    typeof body?.trackingNumber === 'string' ? normalizeTracking(body.trackingNumber) : '';
  if (trackingNumber.length < 8) return c.json({ error: 'A tracking number is required' }, 400);
  // Junk here is worse than a rejection: an unresolvable "number" (QR payload,
  // whole FedEx-96 barcode) becomes a dead row that shadows the real one.
  if (!isValidTracking(trackingNumber)) {
    return c.json({ error: 'A tracking number is letters and digits, at most 30 characters' }, 400);
  }
  if (!CARRIERS.includes(body?.carrier as Carrier)) {
    return c.json({ error: 'carrier must be UPS, FedEx, or USPS' }, 400);
  }
  // Required here even though the column is nullable: pre-existing rows have
  // no answer, but every new box does.
  if (!SOURCES.has(body?.source as string)) {
    return c.json({ error: 'source must be Facebook, Local, Reddit, or Other' }, 400);
  }
  const opt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // Same uppercase-no-spaces canon as the AI extractor, but lenient on shape:
  // a hand-typed id the user swears by must not bounce the whole package.
  const paypalTxnId = opt(body?.paypalTxnId)?.replace(/\s+/g, '').toUpperCase() ?? null;
  if (paypalTxnId !== null && paypalTxnId.length > 64) {
    return c.json({ error: 'PayPal transaction ID is too long' }, 400);
  }

  // ON CONFLICT instead of a pre-check so two concurrent pastes of the same
  // number can't both slip past a SELECT.
  const inserted = (await sql`
    INSERT INTO packages (
      tracking_number, carrier, seller_name, note, source,
      paypal_txn_id, payment_screenshot_key, payment_screenshot_url, created_by
    )
    VALUES (
      ${trackingNumber}, ${body!.carrier as Carrier}, ${opt(body?.sellerName)}, ${opt(body?.note)},
      ${body!.source as PackageSource},
      ${paypalTxnId}, ${opt(body?.paymentScreenshotKey)}, ${opt(body?.paymentScreenshotUrl)}, ${u.id}
    )
    ON CONFLICT (tracking_number) DO NOTHING
    RETURNING ${PACKAGE_COLS(sql)}
  `) as unknown as PackageRow[];
  if (!inserted.length) {
    return c.json({ error: 'This tracking number is already being tracked' }, 409);
  }
  return c.json({ package: toApi(inserted[0], u.name) }, 201);
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
    // The agreed flow is PO-on-delivery, but tracking isn't wired to a live
    // carrier feed yet, so rows can sit in purchased/in_transit forever.
    // Managers may mint the PO at any status as the workaround; purchasers
    // still wait for delivery.
    if (row.status !== 'delivered' && u.role !== 'manager') return { kind: 'notDelivered' };

    const origin = row.status === 'delivered' ? 'Created from delivered package' : 'Created from package';
    const notes = [origin, row.carrier, row.tracking_number, row.seller_name]
      .filter(Boolean).join(' · ');
    // The PO belongs to whoever tracked the box, not whoever clicked: the
    // delivered notification goes to the creator, and ownership drives "my
    // orders" and commission attribution. A manager acting on that
    // notification files it for them — the same on-behalf semantics as
    // POST /api/orders, with the same audit fields.
    const ownerId = row.created_by ?? u.id;
    // The box lands at the owner's home warehouse unless they say otherwise —
    // same defaulting as POST /api/orders.
    const ownerRow = ownerId !== u.id
      ? (await tx`
          SELECT name, default_warehouse_id AS "defaultWarehouseId"
          FROM users WHERE id = ${ownerId} LIMIT 1
        `)[0] as { name: string; defaultWarehouseId: string | null } | undefined
      : undefined;
    const warehouseId = ownerId !== u.id
      ? ownerRow?.defaultWarehouseId ?? null
      : u.defaultWarehouseId;
    const orderId = await insertDraftOrderTx(tx, {
      ownerId,
      actorId: u.id,
      warehouseId,
      notes,
      paypalTxnId: row.paypal_txn_id,
      onBehalfOfName: ownerRow?.name ?? null,
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

  // The DELETE re-checks the guard: a create-po landing between the SELECT
  // above and here matches zero rows, and that must not read as success.
  const deleted = (await sql`
    DELETE FROM packages WHERE id = ${id} AND order_id IS NULL RETURNING id
  `) as unknown as { id: string }[];
  if (!deleted.length) {
    return c.json({ error: 'This package already has a purchase order' }, 409);
  }
  return c.json({ ok: true });
});

export default packages;
