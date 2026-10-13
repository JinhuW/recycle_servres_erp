import { Hono } from 'hono';
import { getDb, type SqlLike } from '../db';
import { nextHumanId } from '../lib/id-seq';
import { isActiveManager } from '../services/members';
import {
  clampLimit, cursorTs, cursorTsParam, cursorTsSelect, decodeCursor, encodeCursor, escapeLike, UUID_RE,
} from '../lib/pagination';
import type { Env, User } from '../types';
import {
  AFTER_SALES_STATUSES, AFTER_SALES_RESOLUTIONS, CASEABLE_SELL_STATUSES, type AfterSalesStatus as CaseStatus,
} from '@recycle-erp/shared';

// After-sales: a customer comes back about goods on a sold order. The case
// runs until the goods come back (return) or a price is agreed (discount).
// It is a record only — it moves no stock and changes no revenue.
const afterSales = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const KNOWN_STATUSES = new Set<string>(AFTER_SALES_STATUSES);

const ALLOWED_TRANSITIONS: Record<CaseStatus, Set<CaseStatus>> = {
  Open:              new Set(['In progress', 'Awaiting return', 'Resolved', 'Cancelled']),
  'In progress':     new Set(['Awaiting return', 'Resolved', 'Cancelled']),
  'Awaiting return': new Set(['In progress', 'Resolved', 'Cancelled']),
  Resolved:          new Set(['Open']),
  Cancelled:         new Set(['Open']),
};
const CLOSED_STATUSES = new Set<string>(['Resolved', 'Cancelled']);
const RESOLUTIONS = new Set<string>(AFTER_SALES_RESOLUTIONS);

const MAX_TEXT = 4000;
const MAX_AMOUNT = 1_000_000_000;

type EventKind = 'created' | 'status' | 'edited' | 'note';

async function writeEvent(
  tx: SqlLike, caseId: string, actorId: string, kind: EventKind,
  f: { from?: string | null; to?: string | null; note?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await tx`
    INSERT INTO after_sales_case_events (case_id, kind, from_status, to_status, note, detail, actor_id)
    VALUES (${caseId}, ${kind}, ${f.from ?? null}, ${f.to ?? null}, ${f.note ?? null},
            ${tx.json((f.detail ?? {}) as never)}, ${actorId})
  `;
}

const cleanText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT ? v.trim() : null;

// null = field absent or cleared; undefined = invalid.
function parseAmount(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return undefined;
  return Math.round(n * 100) / 100;
}

afterSales.get('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const status = c.req.query('status');
  if (status && !KNOWN_STATUSES.has(status)) return c.json({ error: `unknown status: ${status}` }, 400);
  const statusFrag = status ? sql`c.status = ${status}` : sql`TRUE`;

  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  const like = `%${escapeLike(q)}%`;
  const qFrag = q
    ? sql`(c.id ILIKE ${like} OR so.id ILIKE ${like} OR cu.name ILIKE ${like} OR c.issue ILIKE ${like})`
    : sql`TRUE`;

  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));
  const afterTs = cursorTs(cursor);
  const cursorFrag = afterTs && cursor
    ? sql`AND (c.created_at, c.id) < (${cursorTsParam(sql, afterTs)}, ${cursor.id})`
    : sql`AND TRUE`;

  const rows = await sql<{
    id: string; status: string; resolution: string | null; issue: string; amount: number | null;
    created_at: string; updated_at: string; closed_at: string | null; cursor_ts: string;
    sell_order_id: string; sell_order_status: string; currency_code: string;
    customer_id: string; customer_name: string; customer_short: string | null;
    assignee_id: string | null; assignee_name: string | null;
    line_count: number; qty: number;
  }[]>`
    SELECT
      c.id, c.status, c.resolution, c.issue, c.amount::float AS amount,
      c.created_at, c.updated_at, c.closed_at,
      ${cursorTsSelect(sql, sql`c.created_at`)} AS cursor_ts,
      so.id AS sell_order_id, so.status AS sell_order_status, so.currency_code,
      cu.id AS customer_id, cu.name AS customer_name, cu.short_name AS customer_short,
      a.id AS assignee_id, a.name AS assignee_name,
      (SELECT COUNT(*)::int FROM after_sales_case_lines l WHERE l.case_id = c.id) AS line_count,
      (SELECT COALESCE(SUM(l.qty), 0)::int FROM after_sales_case_lines l WHERE l.case_id = c.id) AS qty
    FROM after_sales_cases c
    JOIN sell_orders so ON so.id = c.sell_order_id
    JOIN customers cu ON cu.id = so.customer_id
    LEFT JOIN users a ON a.id = c.assignee_id
    WHERE ${statusFrag} AND ${qFrag} ${cursorFrag}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return c.json({
    rows: slice.map(r => ({
      id: r.id, status: r.status, resolution: r.resolution, issue: r.issue, amount: r.amount,
      createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
      sellOrder: { id: r.sell_order_id, status: r.sell_order_status, currency: r.currency_code },
      customer: { id: r.customer_id, name: r.customer_name, short: r.customer_short },
      assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name } : null,
      lineCount: r.line_count, qty: r.qty,
    })),
    nextCursor: hasMore && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
  });
});

// The page's tiles: every case in scope, not the page the list has loaded.
afterSales.get('/summary', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const rows = await sql<{ status: string; count: number; amount: number }[]>`
    SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS amount
    FROM after_sales_cases GROUP BY status
  `;
  const byStatus: Record<string, { count: number; amount: number }> = {};
  for (const s of AFTER_SALES_STATUSES) byStatus[s] = { count: 0, amount: 0 };
  for (const r of rows) byStatus[r.status] = { count: r.count, amount: r.amount };
  return c.json({ byStatus });
});

afterSales.get('/by-order/:sellOrderId', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const rows = await sql<{
    id: string; status: string; resolution: string | null; amount: number | null; issue: string;
    created_at: string; closed_at: string | null;
  }[]>`
    SELECT id, status, resolution, amount::float AS amount, issue, created_at, closed_at
    FROM after_sales_cases WHERE sell_order_id = ${c.req.param('sellOrderId')}
    ORDER BY created_at DESC, id DESC
  `;
  return c.json({
    cases: rows.map(r => ({
      id: r.id, status: r.status, resolution: r.resolution, amount: r.amount, issue: r.issue,
      createdAt: r.created_at, closedAt: r.closed_at,
    })),
  });
});

afterSales.get('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const head = (await sql<{
    id: string; status: string; resolution: string | null; issue: string; amount: number | null;
    created_at: string; updated_at: string; closed_at: string | null;
    assignee_id: string | null; assignee_name: string | null;
    created_by: string | null; created_by_name: string | null;
    sell_order_id: string; sell_order_status: string; currency_code: string;
    customer_id: string; customer_name: string; customer_short: string | null;
  }[]>`
    SELECT
      c.id, c.status, c.resolution, c.issue, c.amount::float AS amount,
      c.created_at, c.updated_at, c.closed_at,
      a.id AS assignee_id, a.name AS assignee_name,
      cb.id AS created_by, cb.name AS created_by_name,
      so.id AS sell_order_id, so.status AS sell_order_status, so.currency_code,
      cu.id AS customer_id, cu.name AS customer_name, cu.short_name AS customer_short
    FROM after_sales_cases c
    JOIN sell_orders so ON so.id = c.sell_order_id
    JOIN customers cu ON cu.id = so.customer_id
    LEFT JOIN users a ON a.id = c.assignee_id
    LEFT JOIN users cb ON cb.id = c.created_by
    WHERE c.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);

  const [lines, events] = await Promise.all([
    sql<{
      id: string; sell_order_line_id: string | null; label: string; part_number: string | null;
      qty: number; unit_price: number;
    }[]>`
      SELECT id, sell_order_line_id, label, part_number, qty, unit_price::float AS unit_price
      FROM after_sales_case_lines WHERE case_id = ${id} ORDER BY label, id
    `,
    sql<{
      id: string; kind: EventKind; from_status: string | null; to_status: string | null;
      note: string | null; detail: Record<string, unknown>; created_at: string;
      actor_id: string | null; actor_name: string | null;
    }[]>`
      SELECT e.id, e.kind, e.from_status, e.to_status, e.note, e.detail, e.created_at,
             u.id AS actor_id, u.name AS actor_name
      FROM after_sales_case_events e
      LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.case_id = ${id} ORDER BY e.created_at, e.id
    `,
  ]);

  return c.json({
    case: {
      id: head.id, status: head.status, resolution: head.resolution, issue: head.issue, amount: head.amount,
      createdAt: head.created_at, updatedAt: head.updated_at, closedAt: head.closed_at,
      assignee: head.assignee_id ? { id: head.assignee_id, name: head.assignee_name } : null,
      createdBy: head.created_by ? { id: head.created_by, name: head.created_by_name } : null,
      sellOrder: { id: head.sell_order_id, status: head.sell_order_status, currency: head.currency_code },
      customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short },
      lines: lines.map(l => ({
        id: l.id, sellOrderLineId: l.sell_order_line_id, label: l.label, partNumber: l.part_number,
        qty: l.qty, unitPrice: l.unit_price,
      })),
      events: events.map(e => ({
        id: e.id, kind: e.kind, from: e.from_status, to: e.to_status, note: e.note, detail: e.detail,
        at: e.created_at, actor: e.actor_id ? { id: e.actor_id, name: e.actor_name } : null,
      })),
      allowedTo: [...ALLOWED_TRANSITIONS[head.status as CaseStatus]],
    },
  });
});

afterSales.post('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as {
    sellOrderId?: unknown; issue?: unknown; lines?: unknown;
    resolution?: unknown; amount?: unknown; assigneeId?: unknown;
  } | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);
  const sellOrderId = typeof body.sellOrderId === 'string' ? body.sellOrderId : '';
  if (!sellOrderId) return c.json({ error: 'sellOrderId is required' }, 400);
  const issue = cleanText(body.issue);
  if (!issue) return c.json({ error: 'issue is required' }, 400);
  if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 200) {
    return c.json({ error: 'lines must name at least one product' }, 400);
  }
  const wanted = new Map<string, number>();
  for (const raw of body.lines as unknown[]) {
    const l = raw as { sellOrderLineId?: unknown; qty?: unknown };
    if (typeof l?.sellOrderLineId !== 'string' || !UUID_RE.test(l.sellOrderLineId)) {
      return c.json({ error: 'each line needs a sellOrderLineId' }, 400);
    }
    if (typeof l.qty !== 'number' || !Number.isInteger(l.qty) || l.qty < 1) {
      return c.json({ error: 'each line needs a qty of at least 1' }, 400);
    }
    if (wanted.has(l.sellOrderLineId)) return c.json({ error: 'a line is named twice' }, 400);
    wanted.set(l.sellOrderLineId, l.qty);
  }
  const resolution = body.resolution == null || body.resolution === '' ? null : body.resolution;
  if (resolution !== null && (typeof resolution !== 'string' || !RESOLUTIONS.has(resolution))) {
    return c.json({ error: 'resolution must be return or discount' }, 400);
  }
  const amount = parseAmount(body.amount);
  if (amount === undefined) return c.json({ error: 'amount must be a non-negative number' }, 400);
  const assigneeId = body.assigneeId == null || body.assigneeId === '' ? null : body.assigneeId;
  if (assigneeId !== null && typeof assigneeId !== 'string') return c.json({ error: 'invalid assigneeId' }, 400);

  const sql = getDb(c.env);
  if (assigneeId !== null && !(await isActiveManager(sql, assigneeId))) {
    return c.json({ error: 'assigneeId must be an active manager' }, 400);
  }

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'status'; status: string }
    | { kind: 'badLine'; msg: string }
    | { kind: 'created'; id: string };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    // The order is locked so its lines can't be rewritten under the snapshot.
    const so = (await tx<{ status: string }[]>`
      SELECT status FROM sell_orders WHERE id = ${sellOrderId} LIMIT 1 FOR NO KEY UPDATE
    `)[0];
    if (!so) return { kind: 'notFound' };
    if (!CASEABLE_SELL_STATUSES.has(so.status)) return { kind: 'status', status: so.status };

    const ids = [...wanted.keys()];
    const lines = await tx<{
      id: string; label: string; part_number: string | null; qty: number; unit_price: number;
    }[]>`
      SELECT id, label, part_number, qty, unit_price::float AS unit_price
      FROM sell_order_lines WHERE sell_order_id = ${sellOrderId} AND id = ANY(${ids}::uuid[])
    `;
    if (lines.length !== ids.length) return { kind: 'badLine', msg: 'a line is not on this sell order' };
    for (const l of lines) {
      if (wanted.get(l.id)! > l.qty) {
        return { kind: 'badLine', msg: `qty for ${l.label} exceeds the ${l.qty} on the order` };
      }
    }

    const id = await nextHumanId(tx, 'AS', 'AS');
    await tx`
      INSERT INTO after_sales_cases (id, sell_order_id, issue, resolution, amount, assignee_id, created_by)
      VALUES (${id}, ${sellOrderId}, ${issue}, ${resolution}, ${amount}, ${assigneeId}, ${u.id})
    `;
    for (const l of lines) {
      await tx`
        INSERT INTO after_sales_case_lines (case_id, sell_order_line_id, label, part_number, qty, unit_price)
        VALUES (${id}, ${l.id}, ${l.label}, ${l.part_number}, ${wanted.get(l.id)!}, ${l.unit_price})
      `;
    }
    await writeEvent(tx, id, u.id, 'created', {
      to: 'Open', detail: { sellOrderId, resolution, amount, lines: lines.length },
    });
    return { kind: 'created', id };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'sell order not found' }, 404);
    case 'status': return c.json({ error: `a ${outcome.status} order has no goods to come back` }, 409);
    case 'badLine': return c.json({ error: outcome.msg }, 400);
    case 'created': return c.json({ id: outcome.id }, 201);
  }
});

afterSales.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    issue?: unknown; resolution?: unknown; amount?: unknown; assigneeId?: unknown;
  } | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);

  const patch: { issue?: string; resolution?: string | null; amount?: number | null; assignee_id?: string | null } = {};
  if (body.issue !== undefined) {
    const issue = cleanText(body.issue);
    if (!issue) return c.json({ error: 'issue cannot be empty' }, 400);
    patch.issue = issue;
  }
  if (body.resolution !== undefined) {
    const r = body.resolution === null || body.resolution === '' ? null : body.resolution;
    if (r !== null && (typeof r !== 'string' || !RESOLUTIONS.has(r))) {
      return c.json({ error: 'resolution must be return or discount' }, 400);
    }
    patch.resolution = r;
  }
  if (body.amount !== undefined) {
    const a = parseAmount(body.amount);
    if (a === undefined) return c.json({ error: 'amount must be a non-negative number' }, 400);
    patch.amount = a;
  }
  if (body.assigneeId !== undefined) {
    const a = body.assigneeId === null || body.assigneeId === '' ? null : body.assigneeId;
    if (a !== null && typeof a !== 'string') return c.json({ error: 'invalid assigneeId' }, 400);
    patch.assignee_id = a;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to change' }, 400);

  const sql = getDb(c.env);
  if (patch.assignee_id && !(await isActiveManager(sql, patch.assignee_id))) {
    return c.json({ error: 'assigneeId must be an active manager' }, 400);
  }

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'closed'; status: string }
    | { kind: 'needs'; msg: string }
    | { kind: 'ok' };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{
      status: string; issue: string; resolution: string | null; amount: number | null; assignee_id: string | null;
    }[]>`
      SELECT status, issue, resolution, amount::float AS amount, assignee_id
      FROM after_sales_cases WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (CLOSED_STATUSES.has(cur.status)) return { kind: 'closed', status: cur.status };
    // The status route lets only a return await the goods; an edit must not
    // take that back from under it. (The page sends the resolution on every
    // save, so an unchanged 'return' passes.)
    if (patch.resolution !== undefined && cur.status === 'Awaiting return' && patch.resolution !== 'return') {
      return { kind: 'needs', msg: 'a case awaiting its goods keeps the Return resolution — move it back to In progress first' };
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[k] !== cur[k]) changes[k] = { from: cur[k], to: patch[k] };
    }
    if (Object.keys(changes).length === 0) return { kind: 'ok' };

    await tx`
      UPDATE after_sales_cases SET ${tx(patch)}, updated_at = NOW() WHERE id = ${id}
    `;
    await writeEvent(tx, id, u.id, 'edited', { detail: { changes } });
    return { kind: 'ok' };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'closed': return c.json({ error: `a ${outcome.status} case is read-only — reopen it first` }, 409);
    case 'needs': return c.json({ error: outcome.msg }, 409);
    case 'ok': return c.json({ ok: true });
  }
});

afterSales.post('/:id/status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { to?: unknown; note?: unknown } | null;
  const to = typeof body?.to === 'string' ? body.to : '';
  if (!KNOWN_STATUSES.has(to)) return c.json({ error: `unknown status: ${to}` }, 400);
  if (body?.note != null && typeof body.note !== 'string') return c.json({ error: 'invalid note' }, 400);
  if (typeof body?.note === 'string' && body.note.length > MAX_TEXT) return c.json({ error: 'note is too long' }, 400);
  // A blank note is no note, as the timeline reads it.
  const note = cleanText(body?.note);

  const sql = getDb(c.env);
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'idempotent' }
    | { kind: 'illegal'; from: string }
    | { kind: 'needs'; msg: string }
    | { kind: 'ok' };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{ status: CaseStatus; resolution: string | null; amount: number | null }[]>`
      SELECT status, resolution, amount::float AS amount
      FROM after_sales_cases WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (cur.status === to) return { kind: 'idempotent' };
    if (!ALLOWED_TRANSITIONS[cur.status].has(to as CaseStatus)) return { kind: 'illegal', from: cur.status };
    if (to === 'Awaiting return' && cur.resolution !== 'return') {
      return { kind: 'needs', msg: 'only a return can await the goods — set the resolution to Return first' };
    }
    if (to === 'Resolved' && (cur.resolution === null || cur.amount === null)) {
      return { kind: 'needs', msg: 'a resolved case needs its resolution and amount' };
    }
    const closedAt = CLOSED_STATUSES.has(to) ? tx`NOW()` : tx`NULL`;
    await tx`
      UPDATE after_sales_cases SET status = ${to}, closed_at = ${closedAt}, updated_at = NOW()
      WHERE id = ${id}
    `;
    await writeEvent(tx, id, u.id, 'status', { from: cur.status, to, note });
    return { kind: 'ok' };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'idempotent': return c.json({ ok: true, status: to });
    case 'illegal': return c.json({ error: `cannot move a ${outcome.from} case to ${to}` }, 409);
    case 'needs': return c.json({ error: outcome.msg }, 409);
    case 'ok': return c.json({ ok: true, status: to });
  }
});

// The timeline is the case's notes; a closed case can still take one.
afterSales.post('/:id/notes', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { note?: unknown } | null;
  const note = cleanText(body?.note);
  if (!note) return c.json({ error: 'note is required' }, 400);
  const sql = getDb(c.env);
  const found = await sql.begin(async (tx) => {
    const cur = await tx`SELECT 1 FROM after_sales_cases WHERE id = ${id} LIMIT 1 FOR UPDATE`;
    if (cur.length === 0) return false;
    await writeEvent(tx, id, u.id, 'note', { note });
    await tx`UPDATE after_sales_cases SET updated_at = NOW() WHERE id = ${id}`;
    return true;
  });
  if (!found) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default afterSales;
