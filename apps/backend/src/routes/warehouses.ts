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

const optionalInt = (raw: unknown): FieldUpdate<number> => {
  if (raw === undefined) return { set: false };
  if (raw === null || raw === '') return { set: true, value: null };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { set: true, invalid: 'must be an integer' };
  }
  return { set: true, value: n };
};

const CUTOFF_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type DetailInput = {
  address?: FieldUpdate<string>;
  manager?: FieldUpdate<string>;
  managerPhone?: FieldUpdate<string>;
  managerEmail?: FieldUpdate<string>;
  timezone?: FieldUpdate<string>;
  cutoffLocal?: FieldUpdate<string>;
  sqft?: FieldUpdate<number>;
};

function parseDetails(body: Record<string, unknown>): { input: DetailInput; error: string | null } {
  const input: DetailInput = {
    address:      optionalString(body.address),
    manager:      optionalString(body.manager),
    managerPhone: optionalString(body.managerPhone),
    managerEmail: optionalString(body.managerEmail),
    timezone:     optionalString(body.timezone),
    cutoffLocal:  optionalString(body.cutoffLocal),
    sqft:         optionalInt(body.sqft),
  };

  for (const [key, f] of Object.entries(input) as [string, FieldUpdate<unknown>][]) {
    if (f && f.set && 'invalid' in f) {
      return { input, error: `${key} ${f.invalid}` };
    }
  }

  if (input.cutoffLocal?.set && 'value' in input.cutoffLocal
      && input.cutoffLocal.value !== null
      && !CUTOFF_RE.test(input.cutoffLocal.value)) {
    return { input, error: 'cutoffLocal must be HH:MM (00:00 – 23:59)' };
  }
  if (input.managerEmail?.set && 'value' in input.managerEmail
      && input.managerEmail.value !== null
      && !input.managerEmail.value.includes('@')) {
    return { input, error: 'managerEmail must contain @' };
  }
  if (input.sqft?.set && 'value' in input.sqft
      && input.sqft.value !== null && input.sqft.value < 0) {
    return { input, error: 'sqft must be a non-negative integer' };
  }
  return { input, error: null };
}

const val = <T,>(f?: FieldUpdate<T>): T | null => {
  if (!f || !f.set) return null;
  if ('invalid' in f) return null; // shouldn't happen after parseDetails validates
  return f.value;
};

type WhRow = Record<string, unknown>;
const toApi = (r: WhRow) => ({
  id: r.id, name: r.name, short: r.short, region: r.region,
  address:      r.address      ?? null,
  manager:      r.manager      ?? null,
  managerPhone: r.manager_phone ?? null,
  managerEmail: r.manager_email ?? null,
  timezone:     r.timezone     ?? null,
  cutoffLocal:  r.cutoff_local ?? null,
  sqft:         r.sqft         ?? null,
});

// ── routes ──────────────────────────────────────────────────────────────────

warehouses.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, name, short, region,
           address, manager, manager_phone, manager_email,
           timezone, cutoff_local, sqft
    FROM warehouses
    ORDER BY region, short
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
  try {
    const r = await sql`
      INSERT INTO warehouses (
        id, name, short, region,
        address, manager, manager_phone, manager_email,
        timezone, cutoff_local, sqft
      )
      VALUES (
        ${id}, ${name}, ${short}, ${region},
        ${val(input.address)},      ${val(input.manager)},
        ${val(input.managerPhone)}, ${val(input.managerEmail)},
        ${val(input.timezone)},     ${val(input.cutoffLocal)},
        ${val(input.sqft)}
      )
      RETURNING id, name, short, region,
                address, manager, manager_phone, manager_email,
                timezone, cutoff_local, sqft
    `;
    return c.json(toApi(r[0] as WhRow), 201);
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
  if (name === '' || short === '' || region === '') {
    return c.json({ error: 'name, short, region cannot be empty' }, 400);
  }

  const { input, error } = parseDetails(body);
  if (error) return c.json({ error }, 400);

  const flag = (f?: FieldUpdate<string | number>) => (f?.set ? 1 : 0);

  const sql = getDb(c.env);
  const r = await sql`
    UPDATE warehouses SET
      name           = COALESCE(${name},   name),
      short          = COALESCE(${short},  short),
      region         = COALESCE(${region}, region),
      address        = CASE WHEN ${flag(input.address)}::int      = 1 THEN ${val(input.address)}      ELSE address        END,
      manager        = CASE WHEN ${flag(input.manager)}::int      = 1 THEN ${val(input.manager)}      ELSE manager        END,
      manager_phone  = CASE WHEN ${flag(input.managerPhone)}::int = 1 THEN ${val(input.managerPhone)} ELSE manager_phone  END,
      manager_email  = CASE WHEN ${flag(input.managerEmail)}::int = 1 THEN ${val(input.managerEmail)} ELSE manager_email  END,
      timezone       = CASE WHEN ${flag(input.timezone)}::int     = 1 THEN ${val(input.timezone)}     ELSE timezone       END,
      cutoff_local   = CASE WHEN ${flag(input.cutoffLocal)}::int  = 1 THEN ${val(input.cutoffLocal)}  ELSE cutoff_local   END,
      sqft           = CASE WHEN ${flag(input.sqft)}::int         = 1 THEN ${val(input.sqft)}         ELSE sqft           END
    WHERE id = ${id}
    RETURNING id, name, short, region,
              address, manager, manager_phone, manager_email,
              timezone, cutoff_local, sqft
  `;
  if (r.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json(toApi(r[0] as WhRow));
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
