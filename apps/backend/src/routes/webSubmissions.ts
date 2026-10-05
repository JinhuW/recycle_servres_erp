// Manager-only inbox for the public website forms (routes/publicForms.ts):
//   GET    /api/web-submissions            list, filter by site/status/q, keyset paged
//   GET    /api/web-submissions/:id        one submission with its photos
//   PATCH  /api/web-submissions/:id        triage: status, staff note
//   POST   /api/web-submissions/:id/convert  a ram4cash sell lot → Draft PO
//   GET    /api/web-submissions/:id/messages  the email thread + mail mode
//   POST   /api/web-submissions/:id/messages  send a reply from the shared box
//
// Self-applies authMiddleware + requireManager (tracker.ts pattern), so
// index.ts mounts it with a single app.route().

import { Hono } from 'hono';
import { authMiddleware } from '../auth';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { clampLimit, cursorTs, cursorTsParam, cursorTsSelect, decodeCursor, encodeCursor, escapeLike } from '../lib/pagination';
import { copyAttachment, deleteAttachments } from '../r2';
import { insertDraftOrderTx } from '../services/orderDraft';
import { syncOrderCategory } from '../services/orderCategory';
import { syncOrderGoodsTotal } from '../services/orderGoodsTotal';
import { writeOrderEvent } from '../services/orderAudit';
import { isoDatePlus, loadCrmSettings } from '../services/supplierCrm';
import { WEB_CHANNEL_SOURCES, type SellLotPayload } from './publicForms';
import { baseSubject, mailConfig, recipientAllowed, replySubject, siteBrand } from '../mail';
import { sendSubmissionReply, threadMessageIds } from '../mail/send';
import type { Env, User } from '../types';

const webSubmissions = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', requireManager);

const STATUSES = ['new', 'contacted', 'converted', 'archived', 'spam'] as const;
type Status = (typeof STATUSES)[number];
const SITES = ['ram4cash', 'recycleservers'] as const;

// RAM `type` is the tier the DIMM class implies (migration 0027); the form
// only knows the class.
const RAM_TYPE: Record<string, string> = {
  RDIMM: 'Server', LRDIMM: 'Server', UDIMM: 'Desktop', SODIMM: 'Laptop',
};

// Own keys only: the class is the public form's text, and a plain index would
// hand `constructor` back as Object's function, which no column can bind.
function ramType(classification: string | null | undefined): string | null {
  if (!classification || !Object.hasOwn(RAM_TYPE, classification)) return null;
  return RAM_TYPE[classification];
}

type Row = {
  id: string; site: string; kind: string; status: Status;
  // The list's keyset value, µs-exact; absent on the single-row reads.
  cursor_ts?: string;
  name: string | null; company: string | null; email: string; phone: string | null;
  notes: string | null; source: string | null; payload: Record<string, unknown>;
  order_id: string | null; staff_note: string | null;
  handled_by: string | null; handled_by_name: string | null;
  photo_count: number; created_at: Date; updated_at: Date;
};

function view(r: Row) {
  return {
    id: r.id,
    site: r.site,
    kind: r.kind,
    status: r.status,
    name: r.name,
    company: r.company,
    email: r.email,
    phone: r.phone,
    notes: r.notes,
    source: r.source,
    payload: r.payload,
    orderId: r.order_id,
    staffNote: r.staff_note,
    handledBy: r.handled_by ? { id: r.handled_by, name: r.handled_by_name } : null,
    photoCount: Number(r.photo_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

webSubmissions.get('/', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status');
  const site = c.req.query('site');
  const q = c.req.query('q')?.trim();
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));

  const statusFrag = STATUSES.includes(status as Status) ? sql`w.status = ${status!}` : sql`TRUE`;
  const siteFrag = SITES.includes(site as (typeof SITES)[number]) ? sql`w.site = ${site!}` : sql`TRUE`;
  const qFrag = q
    ? sql`(w.id ILIKE ${'%' + escapeLike(q) + '%'} OR w.email ILIKE ${'%' + escapeLike(q) + '%'}
           OR w.name ILIKE ${'%' + escapeLike(q) + '%'} OR w.company ILIKE ${'%' + escapeLike(q) + '%'})`
    : sql`TRUE`;
  const afterTs = cursorTs(cursor);
  const cursorFrag = afterTs && cursor
    ? sql`(w.created_at, w.id) < (${cursorTsParam(sql, afterTs)}, ${cursor.id})`
    : sql`TRUE`;

  const rows = await sql<Row[]>`
    SELECT w.*, u.name AS handled_by_name, ${cursorTsSelect(sql, sql`w.created_at`)} AS cursor_ts,
           (SELECT COUNT(*) FROM web_submission_photos p WHERE p.submission_id = w.id)::int AS photo_count
    FROM web_submissions w
    LEFT JOIN users u ON u.id = w.handled_by
    WHERE ${statusFrag} AND ${siteFrag} AND ${qFrag} AND ${cursorFrag}
    ORDER BY w.created_at DESC, w.id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeCursor({ ts: last.cursor_ts!, id: last.id })
    : null;

  // Tab counts follow the site and search filters but not the status one, so
  // every tab shows what it would list.
  const counts = await sql<{ status: Status; n: number }[]>`
    SELECT w.status, COUNT(*)::int AS n FROM web_submissions w
    WHERE ${siteFrag} AND ${qFrag}
    GROUP BY w.status
  `;
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<Status, number>;
  for (const r of counts) byStatus[r.status] = r.n;

  return c.json({ items: page.map(view), nextCursor, counts: byStatus });
});

async function loadOne(sql: ReturnType<typeof getDb>, id: string) {
  const rows = await sql<Row[]>`
    SELECT w.*, u.name AS handled_by_name,
           (SELECT COUNT(*) FROM web_submission_photos p WHERE p.submission_id = w.id)::int AS photo_count
    FROM web_submissions w
    LEFT JOIN users u ON u.id = w.handled_by
    WHERE w.id = ${id}
  `;
  if (!rows[0]) return null;
  const photos = await sql<{
    id: string; line_index: number; filename: string; mime_type: string; delivery_url: string;
  }[]>`
    SELECT id, line_index, filename, mime_type, delivery_url
    FROM web_submission_photos WHERE submission_id = ${id}
    ORDER BY line_index, position, created_at
  `;
  return {
    ...view(rows[0]),
    photos: photos.map(p => ({
      id: p.id, lineIndex: p.line_index, filename: p.filename, mimeType: p.mime_type, url: p.delivery_url,
    })),
  };
}

webSubmissions.get('/:id', async (c) => {
  const one = await loadOne(getDb(c.env), c.req.param('id'));
  if (!one) return c.json({ error: 'Not found' }, 404);
  return c.json({ submission: one });
});

webSubmissions.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { status?: unknown; staffNote?: unknown } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'JSON body required' }, 400);
  if (body.status !== undefined && !STATUSES.includes(body.status as Status)) {
    return c.json({ error: `status must be one of ${STATUSES.join(', ')}` }, 400);
  }
  // 'converted' is what convert sets; picking it by hand would claim a PO
  // that doesn't exist.
  if (body.status === 'converted') return c.json({ error: 'use Create Draft PO to convert' }, 400);
  if (body.staffNote !== undefined && body.staffNote !== null && typeof body.staffNote !== 'string') {
    return c.json({ error: 'staffNote must be a string' }, 400);
  }

  const sql = getDb(c.env);
  const status = (body.status as Status | undefined) ?? null;
  const hasNote = body.staffNote !== undefined;
  const note = typeof body.staffNote === 'string' ? body.staffNote.trim().slice(0, 2000) || null : null;
  const updated = await sql`
    UPDATE web_submissions SET
      status = COALESCE(${status}, status),
      staff_note = CASE WHEN ${hasNote} THEN ${note} ELSE staff_note END,
      handled_by = ${c.var.user.id},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `;
  if (updated.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ submission: await loadOne(sql, id) });
});

// The house-account supplier a converted lot files under: one per seller, and
// a seller is their email. Looked up by it exactly, among the house accounts
// this form files (sourced by one of its channels), before anything is
// inserted.
//
// The unique index is on the generated match_key — supplier_name_key(name) +
// zip — which is the wrong identity for an email: john.smith@ and johnsmith@
// compress to the same key, and so can any house account someone typed by
// hand. Upserting
// on it filed one seller's lot under somebody else. A key collision therefore
// means a different seller holds that key, and this one is inserted under a
// name that keeps it distinct.
async function webSellerSupplierTx(
  tx: SqlLike,
  submissionId: string,
  p: SellLotPayload,
  categories: string[],
  followUp: string,
  actorId: string,
): Promise<{ id: string }> {
  const [known] = await tx<{ id: string }[]>`
    SELECT id FROM suppliers
    WHERE owner_id IS NULL AND source = ANY(${WEB_CHANNEL_SOURCES})
      AND lower(email) = lower(${p.email})
    ORDER BY created_at, id
    LIMIT 1
  `;
  if (known) {
    await tx`UPDATE suppliers SET last_contacted_at = NOW() WHERE id = ${known.id}`;
    return known;
  }
  // The submission id is the last resort: it is unique, so a name carrying it
  // can never collide, however many sellers' emails compress alike.
  for (const name of [p.email, `${p.email} (web)`, `${p.email} (${submissionId})`]) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO suppliers (name, email, owner_id, source, status, supplies,
                             next_follow_up_at, created_by)
      VALUES (${name}, ${p.email}, NULL, ${p.source}, 'prospect',
              ${categories}, ${followUp}, ${actorId})
      ON CONFLICT (owner_id, match_key) DO NOTHING
      RETURNING id
    `;
    if (row) return row;
  }
  throw new Error(`no free supplier name for web submission ${submissionId}`);
}

webSubmissions.post('/:id/convert', async (c) => {
  const id = c.req.param('id');
  const me = c.var.user;
  const sql = getDb(c.env);

  const [sub] = await sql<{ kind: string; order_id: string | null; payload: SellLotPayload }[]>`
    SELECT kind, order_id, payload FROM web_submissions WHERE id = ${id}
  `;
  if (!sub) return c.json({ error: 'Not found' }, 404);
  if (sub.kind !== 'sell_lot') return c.json({ error: 'only a sell lot can become a PO' }, 400);
  if (sub.order_id) return c.json({ error: `already converted to ${sub.order_id}`, orderId: sub.order_id }, 409);

  const p = sub.payload;
  const photos = await sql<{
    line_index: number; filename: string; size_bytes: number; mime_type: string;
    storage_key: string; delivery_url: string;
  }[]>`
    SELECT line_index, filename, size_bytes, mime_type, storage_key, delivery_url
    FROM web_submission_photos WHERE submission_id = ${id}
    ORDER BY line_index, position, created_at
  `;

  // The PO owns copies, so deleting a photo off the PO never breaks the
  // submission. Copied before the transaction; cleaned up if it fails.
  const copies: { line: number; filename: string; size: number; mime: string; storageKey: string; deliveryUrl: string }[] = [];
  const cleanup = () => deleteAttachments(c.env, copies.map(x => x.storageKey))
    .catch(e => log.warn('web submission convert cleanup', e));
  const prefix = `web-submissions/${id}/po`;
  for (const ph of photos) {
    const r = await copyAttachment(c.env, ph.storage_key, ph.delivery_url, prefix)
      .catch(e => { log.error('web submission photo copy', e); return null; });
    if (!r) {
      await cleanup();
      return c.json({ error: 'photo copy failed' }, 502);
    }
    copies.push({
      line: ph.line_index, filename: ph.filename, size: ph.size_bytes, mime: ph.mime_type,
      storageKey: r.storageKey, deliveryUrl: r.deliveryUrl,
    });
  }

  const categories = [...new Set(p.lines.map(l => (l.category === 'CPU' ? 'Other' : l.category)))];
  const crm = await loadCrmSettings(sql);
  const [owner] = await sql<{ default_warehouse_id: string | null }[]>`
    SELECT default_warehouse_id FROM users WHERE id = ${me.id}
  `;

  let orderId: string;
  try {
    orderId = await sql.begin(async (tx) => {
      // Re-checked under a row lock: two managers clicking at once must not
      // mint two POs for one lot.
      const [live] = await tx<{ order_id: string | null }[]>`
        SELECT order_id FROM web_submissions WHERE id = ${id} FOR UPDATE
      `;
      if (live?.order_id) throw new Error(`__ALREADY__${live.order_id}`);

      const supplier = await webSellerSupplierTx(tx, id, p, categories,
        isoDatePlus(crm.cadenceDays.prospect), me.id);

      const pickup = p.handoff === 'pickup';
      const notes = [
        `Web submission ${id} · ram4cash.com · ${pickup ? `cash pickup (${p.pickup_location ?? '?'})` : `PayPal ${p.email}`}`,
        p.notes,
      ].filter(Boolean).join('\n');
      const orderId = await insertDraftOrderTx(tx, {
        ownerId: me.id,
        actorId: me.id,
        warehouseId: owner?.default_warehouse_id ?? null,
        payment: 'company',
        notes,
        source: p.source === 'web' ? 'other' : p.source,
        supplierId: supplier.id,
      });
      // Nobody bought this on commission, and the seller already chose how to
      // be paid: PayPal upfront for a shipped lot, cash at a pickup.
      await tx`
        UPDATE orders SET
          payment_method = ${pickup ? 'cash' : 'paypal'},
          handoff_method = ${pickup ? 'pickup' : null},
          commission_rate = 0
        WHERE id = ${orderId}
      `;

      for (let i = 0; i < p.lines.length; i++) {
        const l = p.lines[i];
        const f = l.fields;
        // CPU is not an enabled category — it files under Other by item type,
        // the way the PO form does it.
        const category = l.category === 'CPU' ? 'Other' : l.category;
        const row = (await tx<{ id: string }[]>`
          INSERT INTO order_lines (
            order_id, category, brand, capacity, type, classification, rank, speed,
            interface, form_factor, description, item_type, part_number, condition,
            qty, unit_cost, status, position
          ) VALUES (
            ${orderId}, ${category}, ${f.brand ?? null}, ${f.capacity ?? null},
            ${l.category === 'RAM' ? ramType(f.classification) : null},
            ${l.category === 'RAM' ? f.classification ?? null : null},
            ${f.rank ?? null}, ${f.speed ?? null},
            ${f.interface ?? null}, ${f.form_factor ?? null}, ${f.description ?? null},
            ${l.category === 'CPU' ? 'CPU' : null}, ${f.part_number ?? null}, 'Pulled — Untested',
            ${l.qty}, 0, 'Draft', ${i}
          )
          RETURNING id
        `)[0];
        await writeOrderEvent(tx, orderId, me.id, 'line_added', {
          lineId: row.id, category, partNumber: f.part_number ?? null, qty: l.qty, unitCost: 0,
        });
        let pos = 0;
        for (const u of copies.filter(x => x.line === i)) {
          await tx`
            INSERT INTO order_line_photos
              (order_line_id, order_id, filename, size_bytes, mime_type, storage_key, delivery_url, position, uploaded_by)
            VALUES
              (${row.id}::uuid, ${orderId}, ${u.filename}, ${u.size}, ${u.mime},
               ${u.storageKey}, ${u.deliveryUrl}, ${pos++}, ${me.id})
          `;
        }
      }

      // No autoTrackParts: an anonymous part number must not seed ref_prices.
      await syncOrderCategory(tx, orderId);
      await syncOrderGoodsTotal(tx, orderId, true);
      await tx`
        UPDATE web_submissions
        SET order_id = ${orderId}, status = 'converted', handled_by = ${me.id}, updated_at = NOW()
        WHERE id = ${id}
      `;
      return orderId;
    });
  } catch (e) {
    await cleanup();
    const m = e instanceof Error ? /^__ALREADY__(.+)$/.exec(e.message) : null;
    if (m) return c.json({ error: `already converted to ${m[1]}`, orderId: m[1] }, 409);
    throw e;
  }

  return c.json({ orderId, submission: await loadOne(sql, id) }, 201);
});

// A send that never settled — the process died mid-SMTP — may or may not have
// gone out. After this long the page says so instead of spinning forever.
const UNCONFIRMED_AFTER_MS = 2 * 60 * 1000;
const MAX_REPLY_CHARS = 10_000;

type MessageRow = {
  id: string; direction: 'out' | 'in'; from_addr: string; to_addr: string; subject: string;
  body_text: string; status: string; error: string | null; dmarc: string | null;
  attachment_names: string[]; author_id: string | null; author_name: string | null; created_at: Date;
};

function messageView(m: MessageRow) {
  const stale = m.status === 'sending' && Date.now() - m.created_at.getTime() > UNCONFIRMED_AFTER_MS;
  return {
    id: m.id,
    direction: m.direction,
    from: m.from_addr,
    to: m.to_addr,
    subject: m.subject,
    body: m.body_text,
    status: stale ? 'unconfirmed' : m.status,
    error: m.error,
    dmarc: m.dmarc,
    attachmentNames: m.attachment_names,
    author: m.author_id ? { id: m.author_id, name: m.author_name } : null,
    createdAt: m.created_at,
  };
}

async function loadMessages(sql: ReturnType<typeof getDb>, where: { submissionId: string } | { id: string }) {
  const rows = await sql<MessageRow[]>`
    SELECT m.id, m.direction, m.from_addr, m.to_addr, m.subject, m.body_text, m.status, m.error,
           m.dmarc, m.attachment_names, m.author_id, u.name AS author_name, m.created_at
    FROM web_submission_messages m
    LEFT JOIN users u ON u.id = m.author_id
    WHERE ${'id' in where ? sql`m.id = ${where.id}` : sql`m.submission_id = ${where.submissionId}`}
    ORDER BY m.created_at, m.id
  `;
  return rows.map(messageView);
}

webSubmissions.get('/:id/messages', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const [sub] = await sql<{ id: string; site: string; kind: string; email: string }[]>`
    SELECT id, site, kind, email FROM web_submissions WHERE id = ${id}
  `;
  if (!sub) return c.json({ error: 'Not found' }, 404);
  const cfg = mailConfig(c.env);
  const base = baseSubject(sub);
  return c.json({
    messages: await loadMessages(sql, { submissionId: id }),
    mail: {
      mode: cfg?.mode ?? 'off',
      address: cfg?.user ?? null,
      fromName: siteBrand(sub.site).name,
      // The thread's title, and what the next send will carry: the same rule
      // the send path applies, so the draft never shows a subject it won't use.
      threadSubject: base,
      replySubject: replySubject(base, (await threadMessageIds(sql, sub.id)).length > 0),
      // A test sender (MAIL_ALLOW_TO) and whether it would mail this one.
      restricted: Boolean(cfg?.allowTo),
      recipientAllowed: cfg ? recipientAllowed(cfg, sub.email) : false,
    },
  });
});

webSubmissions.post('/:id/messages', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) return c.json({ error: 'body required' }, 400);
  if (text.length > MAX_REPLY_CHARS) return c.json({ error: `body is limited to ${MAX_REPLY_CHARS} characters` }, 400);

  const sql = getDb(c.env);
  const id = c.req.param('id');
  const r = await sendSubmissionReply(sql, c.env, { submissionId: id, authorId: c.var.user.id, body: text });
  if (r.kind === 'off') return c.json({ error: 'mail_off' }, 503);
  if (r.kind === 'not_found') return c.json({ error: 'Not found' }, 404);
  if (r.kind === 'blocked') return c.json({ error: 'recipient_not_allowed' }, 403);
  const [message] = await loadMessages(sql, { id: r.messageRowId });
  if (r.kind === 'failed') return c.json({ error: 'send_failed', message }, 502);
  return c.json({ message, submission: await loadOne(sql, id) }, 201);
});

export default webSubmissions;
