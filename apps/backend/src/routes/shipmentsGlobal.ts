// Cross-PO shipping queries:
//   GET /api/shipments          — every shipment the caller may see, joined
//                                 with the four order fields the table renders
//   GET /api/shipping/contacts  — the seller address book, deduped server-side
//
// Both replace 31-request client-side compositions (orders list + per-order
// shipments) that DesktopShipping and the label wizard used to run.

import { Hono } from 'hono';
import type { Env, User } from '../types';
import { getDb } from '../db';
import { effectiveRole } from '../lib/role';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination';
import { toApi, type ShipmentRow } from './shipments';

type ListRow = ShipmentRow & {
  o_user_name: string;
  o_lifecycle: string;
  wh_id: string | null;
  wh_name: string | null;
  wh_short: string | null;
  wh_region: string | null;
};

export const shipmentsList = new Hono<{ Bindings: Env; Variables: { user: User } }>();

shipmentsList.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = effectiveRole(u) === 'manager';
  const mineOnly = c.req.query('mine') === 'true';
  const limit = clampLimit(c.req.query('limit'), 100, 200);
  // The fragment below casts to ::timestamptz/::uuid, so the values must be
  // castable, not merely present — a garbage cursor falls back to the first
  // page instead of a 22007/22P02 500.
  const raw = decodeCursor(c.req.query('cursor'));
  const cursor =
    raw
    && typeof raw.ts === 'string' && !Number.isNaN(Date.parse(raw.ts))
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id)
      ? raw
      : null;

  // Managers see the org's shipments; purchasers their own orders'. `mine`
  // pins a manager to their own, mirroring GET /api/orders.
  const scopeFrag = isManager && !mineOnly ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  // Fixed newest-first keyset — status/carrier/search narrowing stays
  // client-side where the tested pure helpers (lib/shippingList.ts) live.
  const cursorFrag = cursor
    ? sql`AND (s.created_at, s.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
    : sql`AND TRUE`;

  const rows = (await sql`
    SELECT
      s.id, s.order_id, s.status,
      s.from_name, s.from_phone, s.from_street1, s.from_street2,
      s.from_city, s.from_state, s.from_zip, s.from_country,
      s.weight_oz::float AS weight_oz, s.length_in::float AS length_in,
      s.width_in::float AS width_in, s.height_in::float AS height_in,
      s.carrier, s.service, s.rate_amount::float AS rate_amount, s.rate_currency, s.delivery_days,
      s.provider, s.tracking_number, s.tracking_url, s.label_delivery_url,
      s.label_cost::float AS label_cost, s.fees_applied,
      s.tracking_status, s.tracking_eta, s.last_tracked_at, s.seller_token, s.created_by, s.created_at,
      u.name AS o_user_name, o.lifecycle AS o_lifecycle,
      w.id AS wh_id, w.name AS wh_name, w.short AS wh_short, w.region AS wh_region
    FROM shipments s
    JOIN orders o ON o.id = s.order_id
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE ${scopeFrag} ${cursorFrag}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${limit + 1}
  `) as unknown as ListRow[];

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore
    ? encodeCursor({
        ts: last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at),
        id: last.id,
      })
    : null;

  return c.json({
    items: slice.map((r) => ({
      ...toApi(r),
      order: {
        id: r.order_id,
        userName: r.o_user_name,
        lifecycle: r.o_lifecycle,
        warehouse: r.wh_id
          ? { id: r.wh_id, name: r.wh_name, short: r.wh_short, region: r.wh_region }
          : null,
      },
    })),
    nextCursor,
  });
});

export const shippingContacts = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type ContactRow = {
  key: string;
  from_name: string;
  from_phone: string | null;
  from_street1: string;
  from_street2: string | null;
  from_city: string;
  from_state: string;
  from_zip: string;
  from_country: string | null;
  cnt: number;
  last_used: Date;
};

shippingContacts.get('/contacts', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const scopeFrag = effectiveRole(u) === 'manager' ? sql`TRUE` : sql`o.user_id = ${u.id}`;

  // One entry per (name, street1, zip) — the newest complete address wins and
  // carries how often it shipped. Matches previousSellers() in the frontend,
  // which this replaces. Seller-fill shells (null address) never qualify.
  const rows = (await sql`
    SELECT key, from_name, from_phone, from_street1, from_street2,
           from_city, from_state, from_zip, from_country, cnt, last_used
    FROM (
      SELECT DISTINCT ON (t.key)
        t.key, t.from_name, t.from_phone, t.from_street1, t.from_street2,
        t.from_city, t.from_state, t.from_zip, t.from_country, t.created_at,
        COUNT(*) OVER (PARTITION BY t.key)::int AS cnt,
        MAX(t.created_at) OVER (PARTITION BY t.key) AS last_used
      FROM (
        SELECT s.from_name, s.from_phone, s.from_street1, s.from_street2,
               s.from_city, s.from_state, s.from_zip, s.from_country, s.created_at,
               lower(concat_ws('|', s.from_name, s.from_street1, s.from_zip)) AS key
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        WHERE ${scopeFrag}
          AND s.from_name IS NOT NULL AND s.from_street1 IS NOT NULL
          AND s.from_city IS NOT NULL AND s.from_state IS NOT NULL AND s.from_zip IS NOT NULL
      ) t
      ORDER BY t.key, t.created_at DESC
    ) d
    ORDER BY last_used DESC
    LIMIT 50
  `) as unknown as ContactRow[];

  return c.json({
    items: rows.map((r) => ({
      key: r.key,
      label: `${r.from_name} · ${r.from_city}, ${r.from_state}`,
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
      count: r.cnt,
      lastUsed: r.last_used,
    })),
  });
});
