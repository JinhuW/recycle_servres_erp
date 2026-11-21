import { Hono } from 'hono';
import { getDb, type SqlLike } from '../db';
import { nextHumanId } from '../lib/id-seq';
import { notify } from '../lib/notify';
import { effectiveRole } from '../lib/role';
import {
  clampLimit, cursorTs, cursorTsParam, cursorTsSelect, decodeCursor, encodeCursor, escapeLike, UUID_RE,
} from '../lib/pagination';
import { isActiveUser } from '../services/members';
import { readScope as clientReadScope } from './suppliers';
import type { Env, User } from '../types';
import {
  ACTION_DONE_VISIBLE_DAYS, ACTION_TEXT_MAX, ACTION_TITLE_MAX,
  isActionLinkType, isActionPriority, isActionStatus,
  type ActionColumnOrder, type ActionEvent, type ActionEventKind, type ActionItem, type ActionLink,
  type ActionLinkTarget, type ActionLinkType, type ActionPriority, type ActionStatus,
} from '@recycle-erp/shared';

// The shared action board. Every employee sees every card and may create,
// move, comment on and assign any of them; only removal is limited. What a
// card shows of its linked record follows the record's own read rules.
const actions = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Every write that renumbers a column takes this first. Two cross-column moves
// otherwise lock each other's columns in opposite order (40P01, a 500).
const BOARD_LOCK = 'actions:board';

type Sql = ReturnType<typeof getDb>;

const visibleFrag = (sql: SqlLike) =>
  sql`(a.status <> 'done' OR a.completed_at >= NOW() - ${ACTION_DONE_VISIBLE_DAYS} * INTERVAL '1 day')`;

const linkColFrag = (sql: SqlLike, t: ActionLinkType) => ({
  po: sql`a.order_id`,
  so: sql`a.sell_order_id`,
  as: sql`a.after_sales_id`,
  client: sql`a.supplier_id`,
  ws: sql`a.web_submission_id`,
  lot: sql`a.order_line_id`,
})[t];

type Row = {
  id: string; title: string; description: string | null; status: ActionStatus; position: number;
  priority: ActionPriority; due_date: string | null;
  assignee_id: string | null; assignee_name: string | null; created_by: string | null; creator_name: string | null;
  link_type: ActionLinkType | null; link_label: string | null; link_id: string | null; link_status: string | null;
  po_owner: string | null; client_owner: string | null; client_name: string | null; lot_part: string | null;
  note_count: number; completed_at: string | null; created_at: string; updated_at: string;
};

const SELECT = (sql: SqlLike) => sql`
  SELECT a.id, a.title, a.description, a.status, a.position, a.priority,
         to_char(a.due_date, 'YYYY-MM-DD') AS due_date,
         a.assignee_id, au.name AS assignee_name, a.created_by, cu.name AS creator_name,
         a.link_type, a.link_label,
         COALESCE(a.order_id, a.sell_order_id, a.after_sales_id, a.supplier_id::text,
                  a.web_submission_id, a.order_line_id::text) AS link_id,
         COALESCE(o.lifecycle, so.status, ac.status, s.status, ws.status, ol.status) AS link_status,
         o.user_id AS po_owner, s.owner_id AS client_owner, s.name AS client_name, ol.part_number AS lot_part,
         (SELECT COUNT(*)::int FROM action_item_events e WHERE e.item_id = a.id AND e.kind = 'note') AS note_count,
         a.completed_at, a.created_at, a.updated_at
  FROM action_items a
  LEFT JOIN users au ON au.id = a.assignee_id
  LEFT JOIN users cu ON cu.id = a.created_by
  LEFT JOIN orders o ON o.id = a.order_id
  LEFT JOIN sell_orders so ON so.id = a.sell_order_id
  LEFT JOIN after_sales_cases ac ON ac.id = a.after_sales_id
  LEFT JOIN suppliers s ON s.id = a.supplier_id
  LEFT JOIN web_submissions ws ON ws.id = a.web_submission_id
  LEFT JOIN order_lines ol ON ol.id = a.order_line_id
`;

// Reads scope with effectiveRole, so a manager previewing as a purchaser gets
// the purchaser shape. Withheld fields are left out, not sent as null.
function toLink(r: Row, u: User): ActionLink | null {
  if (!r.link_type || r.link_label === null) return null;
  const type = r.link_type;
  const deleted = r.link_id === null;
  const manager = effectiveRole(u) === 'manager';
  const canOpen = !deleted && (
    manager
    || (type === 'po' && r.po_owner === u.id)
    || (type === 'client' && r.client_owner === u.id)
  );
  const link: ActionLink = { type, id: r.link_id, label: r.link_label, canOpen, deleted };
  if (canOpen) {
    if (r.link_status !== null) link.status = r.link_status;
    if (type === 'client' && r.client_name) link.name = r.client_name;
    if (type === 'lot' && r.lot_part) link.name = r.lot_part;
  }
  return link;
}

function toItem(r: Row, u: User): ActionItem {
  return {
    id: r.id, title: r.title, description: r.description, status: r.status, position: r.position,
    priority: r.priority, dueDate: r.due_date,
    assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name ?? '' } : null,
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name ?? '' } : null,
    link: toLink(r, u),
    noteCount: r.note_count,
    completedAt: r.completed_at, createdAt: r.created_at, updatedAt: r.updated_at,
    canRemove: u.role === 'manager' || r.created_by === u.id,
  };
}

async function readItem(sql: Sql, id: string, u: User): Promise<ActionItem | null> {
  const rows = await sql<Row[]>`${SELECT(sql)} WHERE a.id = ${id} AND a.removed_at IS NULL`;
  return rows[0] ? toItem(rows[0], u) : null;
}

// clock_timestamp, not NOW(): an edit and a reassignment in one transaction
// would otherwise share a timestamp and read back in random order.
async function writeEvent(
  tx: SqlLike, itemId: string, actorId: string, kind: ActionEventKind,
  f: { note?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await tx`
    INSERT INTO action_item_events (item_id, kind, note, detail, actor_id, created_at)
    VALUES (${itemId}, ${kind}, ${f.note ?? null}, ${tx.json((f.detail ?? {}) as never)}, ${actorId},
            clock_timestamp())
  `;
}

async function notifyAssignee(tx: SqlLike, assigneeId: string, actor: User, id: string, title: string) {
  if (assigneeId === actor.id) return;
  await notify(tx, {
    userId: assigneeId, kind: 'action_assigned', title: `${actor.name} assigned you ${id}`, body: title,
  });
}

// --- column order ----------------------------------------------------------

async function columnIds(tx: SqlLike, status: ActionStatus, exceptId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    SELECT a.id FROM action_items a
    WHERE a.status = ${status} AND a.removed_at IS NULL AND a.id <> ${exceptId} AND ${visibleFrag(tx)}
    ORDER BY a.position, a.updated_at DESC, a.id
  `;
  return rows.map(r => r.id);
}

async function writeOrder(tx: SqlLike, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx`
    UPDATE action_items a SET position = v.pos - 1
    FROM unnest(${ids}::text[]) WITH ORDINALITY AS v(id, pos)
    WHERE a.id = v.id AND a.position <> v.pos - 1
  `;
}

const lockBoard = (tx: SqlLike) => tx`SELECT pg_advisory_xact_lock(hashtext(${BOARD_LOCK}))`;

// --- body parsing ------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseTitle(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= ACTION_TITLE_MAX ? t : undefined;
}
// null = cleared; undefined = invalid.
function parseText(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > ACTION_TEXT_MAX) return undefined;
  return v.trim() || null;
}
function parseDate(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
}
function parseAssignee(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  return typeof v === 'string' && UUID_RE.test(v) ? v : undefined;
}
type LinkInput = { type: ActionLinkType; id: string };
function parseLink(v: unknown): LinkInput | null | undefined {
  if (v === null) return null;
  const l = v as { type?: unknown; id?: unknown } | undefined;
  if (!l || !isActionLinkType(l.type) || typeof l.id !== 'string' || l.id.length === 0 || l.id.length > 64) {
    return undefined;
  }
  if ((l.type === 'client' || l.type === 'lot') && !UUID_RE.test(l.id)) return undefined;
  return { type: l.type, id: l.id };
}

type LinkCols = {
  order_id: string | null; sell_order_id: string | null; after_sales_id: string | null;
  supplier_id: string | null; web_submission_id: string | null; order_line_id: string | null;
  link_type: ActionLinkType | null; link_label: string | null;
};
const NO_LINK: LinkCols = {
  order_id: null, sell_order_id: null, after_sales_id: null, supplier_id: null,
  web_submission_id: null, order_line_id: null, link_type: null, link_label: null,
};

// The caller may link only a record they could open. A record they can't is
// answered like a missing one, so the picker reveals nothing by guessing ids.
// A write, so the raw role (lib/role.ts).
async function resolveLink(tx: SqlLike, u: User, l: LinkInput): Promise<LinkCols | null> {
  const manager = u.role === 'manager';
  switch (l.type) {
    case 'po': {
      const r = (await tx<{ user_id: string | null }[]>`SELECT user_id FROM orders WHERE id = ${l.id}`)[0];
      if (!r || (!manager && r.user_id !== u.id)) return null;
      return { ...NO_LINK, order_id: l.id, link_type: 'po', link_label: l.id };
    }
    case 'client': {
      const r = (await tx<{ owner_id: string | null }[]>`SELECT owner_id FROM suppliers WHERE id = ${l.id}`)[0];
      if (!r || (!manager && r.owner_id !== u.id)) return null;
      return { ...NO_LINK, supplier_id: l.id, link_type: 'client', link_label: 'Client' };
    }
    case 'lot': {
      if (!manager) return null;
      const r = (await tx<{ order_id: string; product_no: number }[]>`
        SELECT order_id, product_no FROM order_lines WHERE id = ${l.id}
      `)[0];
      if (!r) return null;
      return { ...NO_LINK, order_line_id: l.id, link_type: 'lot', link_label: `${r.order_id} #${r.product_no}` };
    }
    case 'so': {
      if (!manager || (await tx`SELECT 1 FROM sell_orders WHERE id = ${l.id}`).length === 0) return null;
      return { ...NO_LINK, sell_order_id: l.id, link_type: 'so', link_label: l.id };
    }
    case 'as': {
      if (!manager || (await tx`SELECT 1 FROM after_sales_cases WHERE id = ${l.id}`).length === 0) return null;
      return { ...NO_LINK, after_sales_id: l.id, link_type: 'as', link_label: l.id };
    }
    case 'ws': {
      if (!manager || (await tx`SELECT 1 FROM web_submissions WHERE id = ${l.id}`).length === 0) return null;
      return { ...NO_LINK, web_submission_id: l.id, link_type: 'ws', link_label: l.id };
    }
  }
}

// --- reads -------------------------------------------------------------------

// The board: every open card, plus Done cards from the last two weeks.
actions.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const assignee = c.req.query('assignee');
  let assigneeFrag = sql`TRUE`;
  if (assignee === 'me') assigneeFrag = sql`a.assignee_id = ${u.id}`;
  else if (assignee === 'none') assigneeFrag = sql`a.assignee_id IS NULL`;
  else if (assignee) {
    if (!UUID_RE.test(assignee)) return c.json({ error: 'invalid assignee' }, 400);
    assigneeFrag = sql`a.assignee_id = ${assignee}`;
  }
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  const like = `%${escapeLike(q)}%`;
  const qFrag = q
    ? sql`(a.id ILIKE ${like} OR a.title ILIKE ${like} OR a.link_label ILIKE ${like})`
    : sql`TRUE`;
  const rows = await sql<Row[]>`
    ${SELECT(sql)}
    WHERE a.removed_at IS NULL AND ${visibleFrag(sql)} AND ${assigneeFrag} AND ${qFrag}
    ORDER BY a.status, a.position, a.updated_at DESC, a.id
  `;
  return c.json({ items: rows.map(r => toItem(r, u)) });
});

// Done cards older than the board keeps, newest first.
actions.get('/archive', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));
  const afterTs = cursorTs(cursor);
  const cursorFrag = afterTs && cursor
    ? sql`AND (a.completed_at, a.id) < (${cursorTsParam(sql, afterTs)}, ${cursor.id})`
    : sql`AND TRUE`;
  const rows = await sql<(Row & { cursor_ts: string })[]>`
    SELECT x.*, ${cursorTsSelect(sql, sql`x.completed_at`)} AS cursor_ts FROM (
      ${SELECT(sql)}
      WHERE a.removed_at IS NULL AND a.status = 'done'
        AND a.completed_at < NOW() - ${ACTION_DONE_VISIBLE_DAYS} * INTERVAL '1 day'
        ${cursorFrag}
      ORDER BY a.completed_at DESC, a.id DESC
      LIMIT ${limit + 1}
    ) x
    ORDER BY x.completed_at DESC, x.id DESC
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return c.json({
    items: slice.map(r => toItem(r, u)),
    nextCursor: hasMore && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
  });
});

// The sidebar count and Home's list: the caller's open cards, the most
// pressing first (due soonest, then priority).
actions.get('/mine', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const limit = clampLimit(c.req.query('limit'), 5, 50);
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM action_items
    WHERE assignee_id = ${u.id} AND status <> 'done' AND removed_at IS NULL
  `;
  const rows = await sql<Row[]>`
    ${SELECT(sql)}
    WHERE a.assignee_id = ${u.id} AND a.status <> 'done' AND a.removed_at IS NULL
    ORDER BY a.due_date ASC NULLS LAST,
             CASE a.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
             a.status, a.position
    LIMIT ${limit}
  `;
  return c.json({ count: n, items: rows.map(r => toItem(r, u)) });
});

// One record's cards, for the panel on its page: open first, then done.
actions.get('/by-record', async (c) => {
  const u = c.var.user;
  const type = c.req.query('type');
  const id = c.req.query('id') ?? '';
  if (!isActionLinkType(type)) return c.json({ error: 'unknown type' }, 400);
  if (!id || ((type === 'client' || type === 'lot') && !UUID_RE.test(id))) return c.json({ error: 'invalid id' }, 400);
  const sql = getDb(c.env);
  const rows = await sql<Row[]>`
    ${SELECT(sql)}
    WHERE ${linkColFrag(sql, type)} = ${id} AND a.removed_at IS NULL
    ORDER BY (a.status = 'done'), a.completed_at DESC NULLS FIRST, a.status, a.position
    LIMIT 100
  `;
  return c.json({ items: rows.map(r => toItem(r, u)) });
});

// Open cards per record of one type, for the counts other boards and lists show.
actions.get('/counts', async (c) => {
  const type = c.req.query('type');
  if (!isActionLinkType(type)) return c.json({ error: 'unknown type' }, 400);
  const sql = getDb(c.env);
  const col = linkColFrag(sql, type);
  const rows = await sql<{ id: string; n: number }[]>`
    SELECT ${col}::text AS id, COUNT(*)::int AS n FROM action_items a
    WHERE ${col} IS NOT NULL AND a.status <> 'done' AND a.removed_at IS NULL
    GROUP BY ${col}
  `;
  return c.json({ counts: Object.fromEntries(rows.map(r => [r.id, r.n])) });
});

// The record picker. Only records the caller may open, and no money.
actions.get('/link-targets', async (c) => {
  const u = c.var.user;
  const type = c.req.query('type');
  if (!isActionLinkType(type)) return c.json({ error: 'unknown type' }, 400);
  const manager = effectiveRole(u) === 'manager';
  if (!manager && type !== 'po' && type !== 'client') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const like = `%${escapeLike(q)}%`;
  type T = { id: string; label: string; name: string | null; status: string };
  let rows: T[];
  switch (type) {
    case 'po':
      rows = await sql<T[]>`
        SELECT o.id, o.id AS label, NULL AS name, o.lifecycle AS status FROM orders o
        WHERE ${manager ? sql`TRUE` : sql`o.user_id = ${u.id}`} AND (${!q} OR o.id ILIKE ${like})
        ORDER BY o.created_at DESC LIMIT 10`;
      break;
    case 'client':
      rows = await sql<T[]>`
        SELECT s.id::text AS id, 'Client' AS label, s.name, s.status FROM suppliers s
        WHERE ${clientReadScope(sql, u)} AND (${!q} OR s.name ILIKE ${like} OR s.company ILIKE ${like})
        ORDER BY s.name LIMIT 10`;
      break;
    case 'so':
      rows = await sql<T[]>`
        SELECT so.id, so.id AS label, cu.name, so.status FROM sell_orders so
        LEFT JOIN customers cu ON cu.id = so.customer_id
        WHERE ${!q} OR so.id ILIKE ${like} OR cu.name ILIKE ${like}
        ORDER BY so.created_at DESC LIMIT 10`;
      break;
    case 'as':
      rows = await sql<T[]>`
        SELECT c.id, c.id AS label, c.issue AS name, c.status FROM after_sales_cases c
        WHERE ${!q} OR c.id ILIKE ${like} OR c.sell_order_id ILIKE ${like}
        ORDER BY c.created_at DESC LIMIT 10`;
      break;
    case 'ws':
      rows = await sql<T[]>`
        SELECT w.id, w.id AS label, COALESCE(w.company, w.name, w.email) AS name, w.status FROM web_submissions w
        WHERE ${!q} OR w.id ILIKE ${like} OR w.name ILIKE ${like} OR w.company ILIKE ${like} OR w.email ILIKE ${like}
        ORDER BY w.created_at DESC LIMIT 10`;
      break;
    case 'lot':
      rows = await sql<T[]>`
        SELECT ol.id::text AS id, ol.order_id || ' #' || ol.product_no AS label, ol.part_number AS name, ol.status
        FROM order_lines ol
        WHERE ${!q} OR ol.order_id ILIKE ${like} OR ol.part_number ILIKE ${like}
        ORDER BY ol.created_at DESC LIMIT 10`;
      break;
  }
  const items: ActionLinkTarget[] = rows.map(r => ({
    type, id: r.id, label: r.label, status: r.status, ...(r.name ? { name: r.name } : {}),
  }));
  return c.json({ items });
});

actions.get('/:id', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const item = await readItem(sql, id, u);
  if (!item) return c.json({ error: 'Not found' }, 404);
  const ev = await sql<{
    id: string; kind: ActionEventKind; note: string | null; detail: Record<string, unknown>;
    actor_id: string | null; actor_name: string | null; created_at: string;
  }[]>`
    SELECT e.id, e.kind, e.note, e.detail, e.actor_id, us.name AS actor_name, e.created_at
    FROM action_item_events e LEFT JOIN users us ON us.id = e.actor_id
    WHERE e.item_id = ${id} ORDER BY e.created_at, e.id
  `;
  const events: ActionEvent[] = ev.map(e => ({
    id: e.id, kind: e.kind, note: e.note, detail: e.detail,
    actor: e.actor_id ? { id: e.actor_id, name: e.actor_name ?? '' } : null, createdAt: e.created_at,
  }));
  return c.json({ item, events });
});

// --- writes ------------------------------------------------------------------

actions.post('/', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown; description?: unknown; status?: unknown; priority?: unknown;
    dueDate?: unknown; assigneeId?: unknown; link?: unknown;
  } | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);
  const title = parseTitle(body.title);
  if (!title) return c.json({ error: `title is required (at most ${ACTION_TITLE_MAX} characters)` }, 400);
  const description = body.description === undefined ? null : parseText(body.description);
  if (description === undefined) return c.json({ error: 'description is too long' }, 400);
  const status = body.status === undefined ? 'todo' : body.status;
  if (!isActionStatus(status)) return c.json({ error: 'unknown status' }, 400);
  const priority = body.priority === undefined ? 'normal' : body.priority;
  if (!isActionPriority(priority)) return c.json({ error: 'unknown priority' }, 400);
  const dueDate = body.dueDate === undefined ? null : parseDate(body.dueDate);
  if (dueDate === undefined) return c.json({ error: 'dueDate must be YYYY-MM-DD' }, 400);
  const assigneeId = body.assigneeId === undefined ? null : parseAssignee(body.assigneeId);
  if (assigneeId === undefined) return c.json({ error: 'invalid assigneeId' }, 400);
  const link = body.link === undefined ? null : parseLink(body.link);
  if (link === undefined) return c.json({ error: 'invalid link' }, 400);

  const sql = getDb(c.env);
  if (assigneeId !== null && !(await isActiveUser(sql, assigneeId))) {
    return c.json({ error: 'assigneeId must be an active employee' }, 400);
  }

  type Outcome = { kind: 'noLink' } | { kind: 'created'; id: string };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cols = link ? await resolveLink(tx, u, link) : NO_LINK;
    if (!cols) return { kind: 'noLink' };
    await lockBoard(tx);
    const id = await nextHumanId(tx, 'TK', 'TK');
    await tx`
      INSERT INTO action_items ${tx({
        id, title, description, status, priority, due_date: dueDate, assignee_id: assigneeId,
        created_by: u.id, position: 0, completed_at: status === 'done' ? new Date() : null, ...cols,
      })}
    `;
    // New cards go on top of their column.
    await writeOrder(tx, [id, ...(await columnIds(tx, status, id))]);
    await writeEvent(tx, id, u.id, 'created', { detail: { status, assigneeId, link: cols.link_label } });
    if (assigneeId) await notifyAssignee(tx, assigneeId, u, id, title);
    return { kind: 'created', id };
  });
  if (outcome.kind === 'noLink') return c.json({ error: 'linked record not found' }, 404);
  return c.json({ item: await readItem(sql, outcome.id, u) }, 201);
});

actions.patch('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown; description?: unknown; priority?: unknown; dueDate?: unknown;
    assigneeId?: unknown; link?: unknown;
  } | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);

  const patch: {
    title?: string; description?: string | null; priority?: ActionPriority; due_date?: string | null;
    assignee_id?: string | null;
  } = {};
  if (body.title !== undefined) {
    const t = parseTitle(body.title);
    if (!t) return c.json({ error: `title cannot be empty or over ${ACTION_TITLE_MAX} characters` }, 400);
    patch.title = t;
  }
  if (body.description !== undefined) {
    const d = parseText(body.description);
    if (d === undefined) return c.json({ error: 'description is too long' }, 400);
    patch.description = d;
  }
  if (body.priority !== undefined) {
    if (!isActionPriority(body.priority)) return c.json({ error: 'unknown priority' }, 400);
    patch.priority = body.priority;
  }
  if (body.dueDate !== undefined) {
    const d = parseDate(body.dueDate);
    if (d === undefined) return c.json({ error: 'dueDate must be YYYY-MM-DD' }, 400);
    patch.due_date = d;
  }
  if (body.assigneeId !== undefined) {
    const a = parseAssignee(body.assigneeId);
    if (a === undefined) return c.json({ error: 'invalid assigneeId' }, 400);
    patch.assignee_id = a;
  }
  const link = body.link === undefined ? undefined : parseLink(body.link);
  if (body.link !== undefined && link === undefined) return c.json({ error: 'invalid link' }, 400);
  if (Object.keys(patch).length === 0 && body.link === undefined) return c.json({ error: 'nothing to change' }, 400);

  const sql = getDb(c.env);
  if (patch.assignee_id && !(await isActiveUser(sql, patch.assignee_id))) {
    return c.json({ error: 'assigneeId must be an active employee' }, 400);
  }

  type Outcome = { kind: 'notFound' } | { kind: 'noLink' } | { kind: 'ok' };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{
      title: string; description: string | null; priority: ActionPriority; due_date: string | null;
      assignee_id: string | null; link_label: string | null; link_id: string | null;
    }[]>`
      SELECT title, description, priority, to_char(due_date, 'YYYY-MM-DD') AS due_date, assignee_id, link_label,
             COALESCE(order_id, sell_order_id, after_sales_id, supplier_id::text,
                      web_submission_id, order_line_id::text) AS link_id
      FROM action_items WHERE id = ${id} AND removed_at IS NULL FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
      if (k !== 'assignee_id' && patch[k] !== cur[k]) changes[k] = { from: cur[k], to: patch[k] };
    }
    let cols: LinkCols | undefined;
    if (link !== undefined) {
      const resolved = link === null ? NO_LINK : await resolveLink(tx, u, link);
      if (!resolved) return { kind: 'noLink' };
      // A card whose record was deleted still has its label; clearing it is a change.
      const same = link === null ? cur.link_label === null : link.id === cur.link_id;
      if (!same) {
        cols = resolved;
        changes.link = { from: cur.link_label, to: resolved.link_label };
      }
    }
    const reassigned = patch.assignee_id !== undefined && patch.assignee_id !== cur.assignee_id;
    if (Object.keys(changes).length === 0 && !reassigned && !cols) return { kind: 'ok' };

    await tx`
      UPDATE action_items SET ${tx({ ...patch, ...(cols ?? {}) })}, updated_at = NOW() WHERE id = ${id}
    `;
    if (Object.keys(changes).length > 0) await writeEvent(tx, id, u.id, 'edited', { detail: { changes } });
    if (reassigned) {
      await writeEvent(tx, id, u.id, 'assigned', { detail: { from: cur.assignee_id, to: patch.assignee_id } });
      if (patch.assignee_id) await notifyAssignee(tx, patch.assignee_id, u, id, patch.title ?? cur.title);
    }
    return { kind: 'ok' };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'noLink': return c.json({ error: 'linked record not found' }, 404);
    case 'ok': return c.json({ item: await readItem(sql, id, u) });
  }
});

// Moves a card into a column, above `beforeId` (null = to the bottom). A
// `beforeId` that has since left the column also means the bottom: someone
// else moved it, and the drop should still land. Answers with the order of
// every column it touched, which the board takes as the truth.
actions.post('/:id/move', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { status?: unknown; beforeId?: unknown } | null;
  if (!body || !isActionStatus(body.status)) return c.json({ error: 'unknown status' }, 400);
  const to = body.status;
  const beforeId = body.beforeId ?? null;
  if (beforeId !== null && typeof beforeId !== 'string') return c.json({ error: 'invalid beforeId' }, 400);

  const sql = getDb(c.env);
  type Outcome = { kind: 'notFound' } | { kind: 'ok'; order: ActionColumnOrder };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    await lockBoard(tx);
    const cur = (await tx<{ status: ActionStatus }[]>`
      SELECT status FROM action_items WHERE id = ${id} AND removed_at IS NULL FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    const target = await columnIds(tx, to, id);
    const at = beforeId === null ? -1 : target.indexOf(beforeId);
    if (at < 0) target.push(id); else target.splice(at, 0, id);

    const completedAt = to !== 'done' ? tx`NULL` : cur.status === 'done' ? tx`completed_at` : tx`NOW()`;
    await tx`
      UPDATE action_items SET status = ${to}, completed_at = ${completedAt}, updated_at = NOW() WHERE id = ${id}
    `;
    await writeOrder(tx, target);
    const order: ActionColumnOrder = { [to]: target };
    if (cur.status !== to) {
      const source = await columnIds(tx, cur.status, id);
      await writeOrder(tx, source);
      order[cur.status] = source;
      await writeEvent(tx, id, u.id, 'moved', { detail: { from: cur.status, to } });
    }
    return { kind: 'ok', order };
  });
  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, order: outcome.order });
});

actions.post('/:id/notes', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { note?: unknown } | null;
  const note = parseText(body?.note);
  if (!note) return c.json({ error: 'note is required' }, 400);
  const sql = getDb(c.env);
  const found = await sql.begin(async (tx) => {
    const cur = await tx`SELECT 1 FROM action_items WHERE id = ${id} AND removed_at IS NULL FOR UPDATE`;
    if (cur.length === 0) return false;
    await writeEvent(tx, id, u.id, 'note', { note });
    await tx`UPDATE action_items SET updated_at = NOW() WHERE id = ${id}`;
    return true;
  });
  if (!found) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// Removal hides the card and keeps its history. Its creator or a manager only.
actions.delete('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  type Outcome = { kind: 'notFound' } | { kind: 'forbidden' } | { kind: 'ok' };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{ created_by: string | null }[]>`
      SELECT created_by FROM action_items WHERE id = ${id} AND removed_at IS NULL FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (u.role !== 'manager' && cur.created_by !== u.id) return { kind: 'forbidden' };
    await tx`UPDATE action_items SET removed_at = NOW(), removed_by = ${u.id}, updated_at = NOW() WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'removed');
    return { kind: 'ok' };
  });
  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'forbidden': return c.json({ error: 'only its creator or a manager can remove a card' }, 403);
    case 'ok': return c.json({ ok: true });
  }
});

export default actions;
