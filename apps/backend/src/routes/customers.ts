import { Hono } from 'hono';
import { getDb } from '../db';
import { clampLimit } from '../lib/pagination';
import type { Env, User } from '../types';

const customers = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRING_FIELDS = [
  'name', 'shortName', 'contactName', 'contactEmail', 'contactPhone',
  'address', 'country', 'region', 'notes',
] as const;

// Type-check supplied fields before they reach the COALESCE UPDATE — otherwise
// `body.active as boolean` lets a string through, `tags as string[]` accepts
// anything, etc. Only present fields are checked (PATCH is partial).
function validateCustomerFields(b: Record<string, unknown>): string | null {
  for (const f of STRING_FIELDS) {
    if (b[f] !== undefined && b[f] !== null && typeof b[f] !== 'string') {
      return `${f} must be a string`;
    }
  }
  if (typeof b.contactEmail === 'string' && b.contactEmail.trim() !== '' &&
      !EMAIL_RE.test(b.contactEmail.trim())) {
    return 'contactEmail is not a valid address';
  }
  if (b.tags !== undefined && b.tags !== null &&
      !(Array.isArray(b.tags) && b.tags.every(t => typeof t === 'string'))) {
    return 'tags must be an array of strings';
  }
  if (b.active !== undefined && b.active !== null && typeof b.active !== 'boolean') {
    return 'active must be a boolean';
  }
  return null;
}

customers.get('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const search = c.req.query('q')?.toLowerCase().trim();
  const status = c.req.query('status') ?? 'all';                  // active|inactive|all
  // Bound the result set — this is a fanned-out aggregate over every sell
  // order line, so an unbounded read scales with the whole sales history.
  const limit = clampLimit(c.req.query('limit'), 200, 500);
  const rows = await sql`
    SELECT c.id, c.name, c.short_name, c.contact_name, c.contact_email,
           c.contact_phone, c.address, c.country, c.region,
           c.tags, c.notes, c.active, c.created_at,
           COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS lifetime_revenue,
           COALESCE(SUM(sol.qty * sol.unit_price)
                    FILTER (WHERE so.status <> 'Done'), 0)::float AS outstanding,
           COUNT(DISTINCT so.id)::int AS order_count,
           MAX(so.created_at)         AS last_order
    FROM customers c
    LEFT JOIN sell_orders so       ON so.customer_id = c.id
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE (
      ${search ?? null}::text IS NULL
      OR LOWER(c.name) LIKE '%' || ${search ?? ''} || '%'
      OR LOWER(COALESCE(c.short_name,'')) LIKE '%' || ${search ?? ''} || '%'
    )
    AND ( ${status} = 'all' OR (${status} = 'active' AND c.active) OR (${status} = 'inactive' AND NOT c.active) )
    GROUP BY c.id
    ORDER BY c.name
    LIMIT ${limit}
  `;
  return c.json({ items: rows });
});

customers.post('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { name: string; shortName?: string; contactName?: string; contactEmail?: string;
        contactPhone?: string; address?: string; country?: string; region?: string;
        tags?: string[]; notes?: string }
    | null;
  if (!body?.name) return c.json({ error: 'name is required' }, 400);

  const sql = getDb(c.env);
  const r = await sql`
    INSERT INTO customers (name, short_name, contact_name, contact_email, contact_phone, address, country, region, tags, notes)
    VALUES (${body.name}, ${body.shortName ?? null}, ${body.contactName ?? null},
            ${body.contactEmail ?? null}, ${body.contactPhone ?? null}, ${body.address ?? null},
            ${body.country ?? null}, ${body.region ?? null}, ${body.tags ?? []}, ${body.notes ?? null})
    RETURNING id
  `;
  return c.json({ id: r[0].id }, 201);
});

// Manager dashboard view: every customer with their active vendor-link (if any)
// + a rolled-up bid count. Sorted active-with-link first so the action surface
// (copy / revoke) sits at the top and "generate" candidates queue below.
customers.get('/vendor-links', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const rows = await sql<{
    customer_id: string; customer_name: string; customer_short: string | null;
    region: string | null; active: boolean;
    link_id: string | null; token: string | null;
    created_at: string | null; last_seen_at: string | null;
    bid_count: number;
  }[]>`
    SELECT c.id          AS customer_id,
           c.name        AS customer_name,
           c.short_name  AS customer_short,
           c.region,
           c.active,
           vl.id         AS link_id,
           vl.token,
           vl.created_at,
           vl.last_seen_at,
           COALESCE((SELECT COUNT(*)::int FROM vendor_bids vb
                       WHERE vb.vendor_link_id = vl.id), 0) AS bid_count
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT id, token, created_at, last_seen_at
          FROM vendor_links
         WHERE customer_id = c.id AND active = TRUE
         ORDER BY created_at DESC
         LIMIT 1
      ) vl ON TRUE
     WHERE c.active = TRUE
     ORDER BY (vl.id IS NULL), c.name
  `;
  return c.json({
    items: rows.map(r => ({
      customerId: r.customer_id,
      customerName: r.customer_name,
      customerShort: r.customer_short,
      region: r.region,
      active: r.active,
      link: r.link_id ? {
        id: r.link_id, token: r.token!,
        createdAt: r.created_at, lastSeenAt: r.last_seen_at,
        bidCount: r.bid_count,
      } : null,
    })),
  });
});

// Generate (or regenerate) the active vendor link for a customer. Regenerating
// deactivates any prior link so a leaked token can be rotated.
customers.post('/:id/vendor-link', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const customerId = c.req.param('id');
  const sql = getDb(c.env);

  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const row = (await sql<{ id: string; token: string }[]>`
    WITH deact AS (
      UPDATE vendor_links SET active = FALSE
      WHERE customer_id = ${customerId} AND active = TRUE
    )
    INSERT INTO vendor_links (customer_id, token, created_by)
    VALUES (${customerId}, ${token}, ${u.id})
    RETURNING id, token
  `)[0];
  return c.json({ id: row.id, token: row.token }, 201);
});

customers.get('/:id/vendor-link', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const row = (await sql<{ id: string; token: string; active: boolean;
    expires_at: string | null; label: string | null; created_at: string;
    last_seen_at: string | null }[]>`
    SELECT id, token, active, expires_at, label, created_at, last_seen_at
    FROM vendor_links WHERE customer_id = ${c.req.param('id')} AND active = TRUE
    ORDER BY created_at DESC LIMIT 1
  `)[0];
  if (!row) return c.json({ link: null });
  const bids = (await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM vendor_bids WHERE vendor_link_id = ${row.id}
  `)[0].n;
  return c.json({ link: { ...row, bidCount: bids } });
});

// Registered BEFORE customers.patch('/:id', …) so the broad `/:id` PATCH
// cannot capture the literal `vendor-link` segment.
customers.patch('/vendor-link/:linkId', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const b = (await c.req.json().catch(() => ({}))) as
    { active?: boolean; expiresAt?: string | null; label?: string | null };
  await sql`
    UPDATE vendor_links SET
      active     = COALESCE(${b.active ?? null}, active),
      expires_at = ${b.expiresAt === undefined ? sql`expires_at` : b.expiresAt},
      label      = ${b.label === undefined ? sql`label` : b.label}
    WHERE id = ${c.req.param('linkId')}
  `;
  return c.json({ ok: true });
});

customers.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const invalid = validateCustomerFields(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const sql = getDb(c.env);
  const rows = await sql`
    UPDATE customers SET
      name          = COALESCE(${body.name as string ?? null}, name),
      short_name    = COALESCE(${body.shortName as string ?? null}, short_name),
      contact_name  = COALESCE(${body.contactName as string ?? null}, contact_name),
      contact_email = COALESCE(${body.contactEmail as string ?? null}, contact_email),
      contact_phone = COALESCE(${body.contactPhone as string ?? null}, contact_phone),
      address       = COALESCE(${body.address as string ?? null}, address),
      country       = COALESCE(${body.country as string ?? null}, country),
      region        = COALESCE(${body.region as string ?? null}, region),
      tags          = COALESCE(${body.tags as string[] ?? null}, tags),
      notes         = COALESCE(${body.notes as string ?? null}, notes),
      active        = COALESCE(${body.active as boolean ?? null}, active)
    WHERE id = ${id}
    RETURNING id
  `;
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default customers;
