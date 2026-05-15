import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const warehouses = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// ── helpers ─────────────────────────────────────────────────────────────────

const norm = (s: unknown) => (typeof s === 'string' ? s.trim() : '');

// Optional-string field: undefined → leave column alone; null/'' → clear;
// non-empty → trim and use.
type FieldUpdate<T> =
  | { set: true; value: T | null }
  | { set: true; invalid: string }
  | { set: false };

const optionalString = (raw: unknown): FieldUpdate<string> => {
  if (raw === undefined) return { set: false };
  if (raw === null) return { set: true, value: null };
  if (typeof raw !== 'string') return { set: true, invalid: 'must be a string' };
  const t = raw.trim();
  return { set: true, value: t === '' ? null : t };
};

type DetailInput = {
  address?: FieldUpdate<string>;
  managerUserId?: FieldUpdate<string>;
  timezone?: FieldUpdate<string>;
};

function parseDetails(body: Record<string, unknown>): { input: DetailInput; error: string | null } {
  const input: DetailInput = {
    address:       optionalString(body.address),
    managerUserId: optionalString(body.managerUserId),
    timezone:      optionalString(body.timezone),
  };

  for (const [key, f] of Object.entries(input) as [string, FieldUpdate<unknown>][]) {
    if (f && f.set && 'invalid' in f) {
      return { input, error: `${key} ${f.invalid}` };
    }
  }

  return { input, error: null };
}

const val = <T,>(f?: FieldUpdate<T>): T | null => {
  if (!f || !f.set) return null;
  if ('invalid' in f) return null; // shouldn't happen after parseDetails validates
  return f.value;
};

// True when managerUserId was supplied with a non-null value that does not
// match an existing user (covers unknown ids and malformed uuids). Lets us
// 400 before mutating instead of surfacing a raw FK violation.
async function managerUserMissing(
  sql: ReturnType<typeof getDb>,
  input: DetailInput,
): Promise<boolean> {
  const f = input.managerUserId;
  if (!f || !f.set || 'invalid' in f || f.value === null) return false;
  try {
    const rows = await sql`SELECT 1 FROM users WHERE id = ${f.value}::uuid`;
    return rows.length === 0;
  } catch {
    return true;
  }
}

type WhRow = Record<string, unknown>;
const toApi = (r: WhRow) => ({
  id: r.id, name: r.name, short: r.short, region: r.region,
  address:       r.address         ?? null,
  managerUserId: r.manager_user_id ?? null,
  manager:       r.manager         ?? null, // users.name  of the linked manager
  managerPhone:  r.manager_phone   ?? null, // users.phone (derived)
  managerEmail:  r.manager_email   ?? null, // users.email (derived)
  timezone:      r.timezone        ?? null,
  active:        (r.active ?? true) as boolean,
});

// Single source for the warehouse projection: manager name/phone/email are
// derived from the linked users row, never stored on the warehouse.
async function fetchWarehouse(
  sql: ReturnType<typeof getDb>, id: string,
): Promise<WhRow | null> {
  const rows = await sql`
    SELECT w.id, w.name, w.short, w.region, w.address,
           w.timezone, w.active, w.manager_user_id,
           mu.name AS manager, mu.phone AS manager_phone, mu.email AS manager_email
    FROM warehouses w
    LEFT JOIN users mu ON mu.id = w.manager_user_id
    WHERE w.id = ${id}
  `;
  return (rows[0] as WhRow) ?? null;
}

// ── routes ──────────────────────────────────────────────────────────────────

warehouses.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT w.id, w.name, w.short, w.region, w.address,
           w.timezone, w.active, w.manager_user_id,
           mu.name AS manager, mu.phone AS manager_phone, mu.email AS manager_email
    FROM warehouses w
    LEFT JOIN users mu ON mu.id = w.manager_user_id
    WHERE w.active = TRUE
    ORDER BY w.region, w.short
  `;
  return c.json({ items: rows.map((r) => toApi(r as WhRow)) });
});

warehouses.post('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const name = norm(body.name);
  const short = norm(body.short).toUpperCase();
  const region = norm(body.region);
  if (!name || !short || !region) {
    return c.json({ error: 'name, short, region are required' }, 400);
  }
  const id = norm(body.id) || `WH-${short}`;

  const { input, error } = parseDetails(body);
  if (error) return c.json({ error }, 400);

  const sql = getDb(c.env);
  if (await managerUserMissing(sql, input)) {
    return c.json({ error: 'managerUserId must reference an existing user' }, 400);
  }
  try {
    const ins = await sql`
      INSERT INTO warehouses (
        id, name, short, region,
        address, manager_user_id, timezone
      )
      VALUES (
        ${id}, ${name}, ${short}, ${region},
        ${val(input.address)}, ${val(input.managerUserId)}::uuid,
        ${val(input.timezone)}
      )
      RETURNING id
    `;
    const row = await fetchWarehouse(sql, (ins[0] as { id: string }).id);
    return c.json(toApi(row as WhRow), 201);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (/duplicate|unique/i.test(msg)) {
      return c.json({ error: `Warehouse "${id}" already exists` }, 409);
    }
    throw e;
  }
});

warehouses.patch('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  // Required-field updates (cannot be cleared): if the key is present it must be non-empty.
  const name   = body.name   !== undefined ? norm(body.name)                : null;
  const short  = body.short  !== undefined ? norm(body.short).toUpperCase() : null;
  const region = body.region !== undefined ? norm(body.region)              : null;
  // Soft-archive flag. Only a real boolean toggles it; absent/other → leave as-is.
  const active = typeof body.active === 'boolean' ? body.active : null;
  if (name === '' || short === '' || region === '') {
    return c.json({ error: 'name, short, region cannot be empty' }, 400);
  }

  const { input, error } = parseDetails(body);
  if (error) return c.json({ error }, 400);

  const sql = getDb(c.env);
  if (await managerUserMissing(sql, input)) {
    return c.json({ error: 'managerUserId must reference an existing user' }, 400);
  }

  const flag = (f?: FieldUpdate<string | number>) => (f?.set ? 1 : 0);
  const r = await sql`
    UPDATE warehouses SET
      name            = COALESCE(${name},   name),
      short           = COALESCE(${short},  short),
      region          = COALESCE(${region}, region),
      address         = CASE WHEN ${flag(input.address)}::int       = 1 THEN ${val(input.address)}             ELSE address         END,
      manager_user_id = CASE WHEN ${flag(input.managerUserId)}::int = 1 THEN ${val(input.managerUserId)}::uuid ELSE manager_user_id END,
      timezone        = CASE WHEN ${flag(input.timezone)}::int      = 1 THEN ${val(input.timezone)}            ELSE timezone        END,
      active          = COALESCE(${active}, active)
    WHERE id = ${id}
    RETURNING id
  `;
  if (r.length === 0) return c.json({ error: 'not found' }, 404);
  const row = await fetchWarehouse(sql, id);
  return c.json(toApi(row as WhRow));
});

// DELETE /:id[?transferTo=<warehouseId>] — unchanged.
warehouses.delete('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const transferToRaw = c.req.query('transferTo');
  const transferTo = transferToRaw && transferToRaw.trim() ? transferToRaw.trim() : null;
  if (transferTo === id) return c.json({ error: 'transferTo must differ from the warehouse being deleted' }, 400);

  const sql = getDb(c.env);

  if (transferTo) {
    const exists = await sql`SELECT id FROM warehouses WHERE id = ${transferTo}`;
    if (exists.length === 0) return c.json({ error: `transferTo warehouse "${transferTo}" not found` }, 404);
  }

  let deleted = 0;
  await sql.begin(async (tx) => {
    await tx`UPDATE orders           SET warehouse_id = ${transferTo} WHERE warehouse_id = ${id}`;
    await tx`UPDATE order_lines      SET warehouse_id = ${transferTo} WHERE warehouse_id = ${id}`;
    await tx`UPDATE sell_order_lines SET warehouse_id = ${transferTo} WHERE warehouse_id = ${id}`;
    const r = await tx`DELETE FROM warehouses WHERE id = ${id} RETURNING id`;
    deleted = r.length;
  });
  if (deleted === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

export default warehouses;
