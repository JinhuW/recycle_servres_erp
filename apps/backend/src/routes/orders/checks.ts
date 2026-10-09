// Review mode: a manager's count of a PO against the box that arrived.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { UUID_RE } from '../../lib/pagination';
import { writeOrderEvent, type SqlLike } from '../../services/orderAudit';
import { notify } from '../../lib/notify';
import { poLineOrder } from '../../lib/poLineNo';
import { type OrdersEnv } from './shared';

const checksRoutes = new Hono<OrdersEnv>();

// ── Box check: a manager counting a PO against the box that arrived.
// Whole-endpoint gate on the raw role, like the other manager-only doors: a
// manager previewing as a purchaser is still the one holding the box.
const CHECK_FLAG_REASONS = ['missing', 'short', 'wrong_part', 'damaged', 'not_as_described'] as const;
type CheckFlagReason = typeof CHECK_FLAG_REASONS[number];
const CHECK_NOTE_MAX = 500;

type CheckOrderRow = { id: string; user_id: string; archived_at: Date | null };
async function checkOrder(sql: SqlLike, id: string): Promise<CheckOrderRow | undefined> {
  return (await sql<CheckOrderRow[]>`
    SELECT id, user_id, archived_at FROM orders WHERE id = ${id} LIMIT 1`)[0];
}

async function readChecks(sql: SqlLike, id: string) {
  const lines = await sql<{
    line_id: string; counted: number; flag_reason: CheckFlagReason | null;
    flag_note: string | null; checked_at: Date | null; flag_sent_at: Date | null;
  }[]>`
    SELECT k.line_id, k.counted, k.flag_reason, k.flag_note, k.checked_at, k.flag_sent_at
    FROM order_line_checks k JOIN order_lines l ON l.id = k.line_id
    WHERE l.order_id = ${id}`;
  const extras = await sql<{
    id: string; part_number: string; note: string | null; created_at: Date; sent_at: Date | null;
  }[]>`
    SELECT id, part_number, note, created_at, sent_at FROM order_check_extras
    WHERE order_id = ${id} ORDER BY created_at ASC, id ASC`;
  return {
    lines: lines.map((r) => ({
      lineId: r.line_id, counted: r.counted, flagReason: r.flag_reason,
      flagNote: r.flag_note, checkedAt: r.checked_at, flagSentAt: r.flag_sent_at,
    })),
    extras: extras.map((r) => ({
      id: r.id, partNumber: r.part_number, note: r.note, createdAt: r.created_at, sentAt: r.sent_at,
    })),
  };
}

// undefined = present but not text (a 400); null = empty.
function cleanCheckNote(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  return v.trim().slice(0, CHECK_NOTE_MAX) || null;
}

checksRoutes.get('/:id/checks', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!await checkOrder(sql, id)) return c.json({ error: 'Not found' }, 404);
  return c.json(await readChecks(sql, id));
});

checksRoutes.put('/:id/checks/:lineId', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const order = await checkOrder(sql, id);
  if (!order || !UUID_RE.test(lineId)) return c.json({ error: 'Not found' }, 404);
  if (order.archived_at) return c.json({ error: 'Order is archived — unarchive it first' }, 409);

  const body = (await c.req.json().catch(() => null)) as
    { counted?: unknown; checked?: unknown; flagReason?: unknown; flagNote?: unknown } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const line = (await sql<{ qty: number }[]>`
    SELECT qty FROM order_lines WHERE id = ${lineId} AND order_id = ${id} LIMIT 1`)[0];
  if (!line) return c.json({ error: 'Not found' }, 404);
  const counted = body.counted;
  if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0 || counted > line.qty) {
    return c.json({ error: `counted must be a whole number from 0 to ${line.qty}` }, 400);
  }
  const reason = body.flagReason ?? null;
  if (reason !== null && !CHECK_FLAG_REASONS.includes(reason as CheckFlagReason)) {
    return c.json({ error: 'Unknown flag reason' }, 400);
  }
  const note = cleanCheckNote(body.flagNote);
  if (note === undefined) return c.json({ error: 'flagNote must be text' }, 400);
  if (body.checked !== undefined && typeof body.checked !== 'boolean') {
    return c.json({ error: 'checked must be true or false' }, 400);
  }
  // The count starts at the line's qty, so a full count no longer means the
  // manager looked: checked is its own answer. A bundle from before that
  // change sends none, and meant "full count" by it.
  const checked = body.checked ?? counted === line.qty;

  await sql`
    INSERT INTO order_line_checks (line_id, counted, flag_reason, flag_note, checked_at, updated_by, updated_at)
    VALUES (${lineId}, ${counted}, ${reason as string | null}, ${reason ? note : null},
            ${checked ? sql`NOW()` : null}, ${u.id}, NOW())
    ON CONFLICT (line_id) DO UPDATE SET
      counted = EXCLUDED.counted,
      flag_reason = EXCLUDED.flag_reason,
      flag_note = EXCLUDED.flag_note,
      checked_at = CASE WHEN ${checked} THEN COALESCE(order_line_checks.checked_at, NOW()) END,
      -- A changed flag is a new message; a count-only write keeps the stamp.
      flag_sent_at = CASE
        WHEN order_line_checks.flag_reason IS DISTINCT FROM EXCLUDED.flag_reason
          OR order_line_checks.flag_note IS DISTINCT FROM EXCLUDED.flag_note THEN NULL
        ELSE order_line_checks.flag_sent_at END,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()`;
  return c.json(await readChecks(sql, id));
});

checksRoutes.post('/:id/checks/extras', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const order = await checkOrder(sql, id);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (order.archived_at) return c.json({ error: 'Order is archived — unarchive it first' }, 409);
  const body = (await c.req.json().catch(() => null)) as { partNumber?: unknown; note?: unknown } | null;
  const pn = typeof body?.partNumber === 'string' ? body.partNumber.trim().slice(0, 120) : '';
  if (!pn) return c.json({ error: 'partNumber is required' }, 400);
  const note = cleanCheckNote(body?.note);
  if (note === undefined) return c.json({ error: 'note must be text' }, 400);
  await sql`
    INSERT INTO order_check_extras (order_id, part_number, note, created_by)
    VALUES (${id}, ${pn}, ${note}, ${u.id})`;
  return c.json(await readChecks(sql, id), 201);
});

checksRoutes.delete('/:id/checks/extras/:extraId', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const extraId = c.req.param('extraId');
  const order = await checkOrder(sql, id);
  if (!order || !UUID_RE.test(extraId)) return c.json({ error: 'Not found' }, 404);
  if (order.archived_at) return c.json({ error: 'Order is archived — unarchive it first' }, 409);
  const gone = await sql`DELETE FROM order_check_extras WHERE id = ${extraId} AND order_id = ${id}`;
  if (gone.count === 0) return c.json({ error: 'Not found' }, 404);
  return c.json(await readChecks(sql, id));
});

// The flags go to the purchaser as a notification and stay on the order's
// history. The stage is left alone: what happens next is a conversation, not
// a transition.  Only what hasn't gone out yet is sent, so a second click — or
// a second manager opening the page — doesn't repeat the message.
checksRoutes.post('/:id/checks/send', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const order = await checkOrder(sql, id);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (order.archived_at) return c.json({ error: 'Order is archived — unarchive it first' }, 409);

  const sent = await sql.begin(async (tx) => {
    const flags = await tx<{
      line_id: string; product_no: number; part_number: string | null; qty: number; counted: number;
      flag_reason: CheckFlagReason; flag_note: string | null;
    }[]>`
      SELECT l.id AS line_id, l.product_no, l.part_number, l.qty, k.counted, k.flag_reason, k.flag_note
      FROM order_line_checks k JOIN order_lines l ON l.id = k.line_id
      WHERE l.order_id = ${id} AND k.flag_reason IS NOT NULL AND k.flag_sent_at IS NULL
      ORDER BY ${poLineOrder(tx, 'l')}
      FOR UPDATE OF k`;
    const extras = await tx<{ id: string; part_number: string; note: string | null }[]>`
      SELECT id, part_number, note FROM order_check_extras
      WHERE order_id = ${id} AND sent_at IS NULL ORDER BY created_at ASC, id ASC
      FOR UPDATE`;
    if (flags.length === 0 && extras.length === 0) return null;
    if (flags.length) {
      await tx`UPDATE order_line_checks SET flag_sent_at = NOW()
               WHERE line_id IN ${tx(flags.map((f) => f.line_id))}`;
    }
    if (extras.length) {
      await tx`UPDATE order_check_extras SET sent_at = NOW()
               WHERE id IN ${tx(extras.map((x) => x.id))}`;
    }

    const detail = {
      flags: flags.map((f) => ({
        lineId: f.line_id, no: f.product_no, partNumber: f.part_number, qty: f.qty, counted: f.counted,
        reason: f.flag_reason, note: f.flag_note,
      })),
      extras: extras.map((x) => ({ partNumber: x.part_number, note: x.note })),
    };
    await writeOrderEvent(tx, id, u.id, 'box_check_flagged', detail);
    if (order.user_id !== u.id) {
      const n = flags.length + extras.length;
      await notify(tx, {
        userId: order.user_id,
        kind: 'box_check',
        tone: 'warn',
        icon: 'flag',
        title: `${id}: ${n} ${n === 1 ? 'problem' : 'problems'} found in the box`,
        body: [
          ...flags.map((f) => `#${f.product_no}${f.part_number ? ` ${f.part_number}` : ''}: ${f.flag_reason.replace(/_/g, ' ')}`
            + (f.flag_note ? ` (${f.flag_note})` : '')),
          ...extras.map((x) => `Extra item ${x.part_number}` + (x.note ? ` (${x.note})` : '')),
        ].join('\n'),
      });
    }
    return detail;
  });
  if (!sent) {
    return c.json({ error: 'Nothing new to send — every flag and extra item has already gone to the purchaser.' }, 409);
  }
  return c.json({
    ...await readChecks(sql, id),
    ok: true, sentFlags: sent.flags.length, sentExtras: sent.extras.length, notified: order.user_id !== u.id,
  });
});

export default checksRoutes;
