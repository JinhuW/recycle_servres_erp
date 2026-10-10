import { Hono } from 'hono';
import { isEmail } from '../lib/email';
import { getDb } from '../db';
import { committedSellStatuses } from '../lib/sellCommitment';
import { clampLimit } from '../lib/pagination';
import type { Env, User } from '../types';

const customers = new Hono<{ Bindings: Env; Variables: { user: User } }>();

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
      !isEmail(b.contactEmail.trim())) {
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
           -- Revenue is what was sold (Done, archived ones included); what
           -- is owed is what has shipped or is awaiting payment. Drafts and
           -- Closed orders are neither, and counting them inflated both.
           COALESCE(SUM(sol.qty * sol.unit_price)
                    FILTER (WHERE so.status = 'Done'), 0)::float AS lifetime_revenue,
           COALESCE(SUM(sol.qty * sol.unit_price)
                    FILTER (WHERE so.status = ANY(${committedSellStatuses()}::text[])), 0)::float AS outstanding,
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
    RETURNING id, name, short_name, region
  `;
  // Return the row so the order-form picker can render it in place without a reload.
  return c.json({ id: r[0].id, customer: r[0] }, 201);
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
