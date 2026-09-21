// Unauthenticated sell-form intake for cash4ram.com, mounted at
// /api/public/intake (CSRF-exempt like the rest of /api/public/*, see
// csrf.ts). A submission becomes an ordinary Draft PO — lines at cost 0,
// photos on the lines — owned by a house user and attached to a house-account
// supplier, so staff price it in the PO screen they already use.
//
// There is no credential: the form is public by design. What stands between
// the internet and the orders table is the validation below, a per-IP
// budget, a honeypot, and the fact that nothing here reads back anything but
// the new PO id.

import { Hono } from 'hono';
import { getDb } from '../db';
import { log } from '../lib/log';
import { createRateLimiter } from '../lib/rate-limit';
import { notifyManagers } from '../lib/notify';
import { getUploadLimits } from '../lib/settings';
import { shrinkImageToFit } from '../lib/image-shrink';
import { deleteAttachments, uploadAttachment, UnsafeMimeError } from '../r2';
import { insertDraftOrderTx } from '../services/orderDraft';
import { syncOrderCategory } from '../services/orderCategory';
import { syncOrderGoodsTotal } from '../services/orderGoodsTotal';
import { writeOrderEvent } from '../services/orderAudit';
import { isoDatePlus, loadCrmSettings } from '../services/supplierCrm';
import type { Env } from '../types';

const intake = new Hono<{ Bindings: Env }>();

const MAX_LINES = 20;
const MAX_QTY = 9999;
const MAX_TEXT = 120;
const PHOTOS_PER_LINE = 4;
const PHOTOS_PER_REQUEST = 20;
// Five lots a minute from one address is generous for a person and cheap
// for a script; the limiter is per-process, which is the same trade-off
// /api/scan already makes.
const rateLimited = createRateLimiter(60_000, 5);

const CATEGORIES = ['RAM', 'SSD', 'CPU'] as const;
type Category = (typeof CATEGORIES)[number];
const SOURCES = ['web', 'facebook', 'reddit'] as const;
type Source = (typeof SOURCES)[number];
// The spec fields the form can send, all optional. Anything else is dropped.
const FIELD_KEYS = [
  'classification', 'capacity', 'speed', 'rank', 'brand',
  'interface', 'form_factor', 'description', 'part_number',
] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

type Line = { category: Category; qty: number; fields: Partial<Record<FieldKey, string>> };
type Payload = { email: string; notes: string | null; source: Source; lines: Line[] };

// RAM `type` is the tier the DIMM class implies (migration 0027); the form
// only knows the class.
const RAM_TYPE: Record<string, string> = {
  RDIMM: 'Server', LRDIMM: 'Server', UDIMM: 'Desktop', SODIMM: 'Laptop',
};

function clientIp(h: (name: string) => string | undefined): string {
  return h('x-forwarded-for')?.split(',')[0]?.trim() || h('x-real-ip') || 'anon';
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

// Returns the cleaned payload, or the message to answer 400 with. The
// honeypot is reported separately: a filled one is answered 200 and ignored,
// so a bot can't tell it was caught.
function parsePayload(raw: unknown): { ok: Payload } | { error: string } | { honeypot: true } {
  if (!raw || typeof raw !== 'object') return { error: 'payload must be an object' };
  const b = raw as Record<string, unknown>;
  if (typeof b.website === 'string' && b.website.trim()) return { honeypot: true };

  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > MAX_TEXT) {
    return { error: 'a valid PayPal email is required' };
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) return { error: 'at least one line is required' };
  if (b.lines.length > MAX_LINES) return { error: `at most ${MAX_LINES} lines per submission` };

  const lines: Line[] = [];
  for (let i = 0; i < b.lines.length; i++) {
    const l = b.lines[i] as Record<string, unknown> | null;
    if (!l || typeof l !== 'object') return { error: `line ${i + 1}: must be an object` };
    if (!CATEGORIES.includes(l.category as Category)) {
      return { error: `line ${i + 1}: category must be RAM, SSD, or CPU` };
    }
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return { error: `line ${i + 1}: qty must be a whole number between 1 and ${MAX_QTY}` };
    }
    const src = (l.fields && typeof l.fields === 'object' ? l.fields : {}) as Record<string, unknown>;
    const fields: Partial<Record<FieldKey, string>> = {};
    for (const k of FIELD_KEYS) {
      const v = text(src[k]);
      if (v) fields[k] = v;
    }
    lines.push({ category: l.category as Category, qty, fields });
  }

  const notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 2000) || null : null;
  const source = SOURCES.includes(b.source as Source) ? (b.source as Source) : 'web';
  return { ok: { email, notes, source, lines } };
}

// The seller's photos, grouped by line index, from `photo-<line>-<n>` parts.
function collectPhotos(form: FormData, lineCount: number): File[][] | { error: string } {
  const byLine: File[][] = Array.from({ length: lineCount }, () => []);
  let total = 0;
  for (const [name, value] of form.entries()) {
    const m = /^photo-(\d+)-\d+$/.exec(name);
    if (!m || !(value instanceof File) || value.size === 0) continue;
    const idx = Number(m[1]);
    if (idx >= lineCount) return { error: `${name}: no such line` };
    if (byLine[idx].length >= PHOTOS_PER_LINE) return { error: `line ${idx + 1}: at most ${PHOTOS_PER_LINE} photos` };
    if (++total > PHOTOS_PER_REQUEST) return { error: `at most ${PHOTOS_PER_REQUEST} photos per submission` };
    byLine[idx].push(value);
  }
  return byLine;
}

// A line with neither a photo nor anything that identifies the part gives
// staff nothing to price — the form enforces the same rule client-side.
function unidentified(l: Line, photos: File[]): boolean {
  return photos.length === 0 && !l.fields.part_number && !l.fields.capacity && !l.fields.description;
}

async function resolveOwner(
  sql: ReturnType<typeof getDb>,
  env: Env,
): Promise<{ id: string; defaultWarehouseId: string | null } | null> {
  type Row = { id: string; default_warehouse_id: string | null };
  const configured = env.INTAKE_OWNER_USER_ID;
  if (configured && /^[0-9a-f-]{36}$/i.test(configured)) {
    const rows = await sql<Row[]>`
      SELECT id, default_warehouse_id FROM users
      WHERE id = ${configured} AND COALESCE(active, TRUE) LIMIT 1
    `;
    if (rows[0]) return { id: rows[0].id, defaultWarehouseId: rows[0].default_warehouse_id };
  }
  const rows = await sql<Row[]>`
    SELECT id, default_warehouse_id FROM users
    WHERE role = 'manager' AND COALESCE(active, TRUE)
    ORDER BY created_at, id LIMIT 1
  `;
  return rows[0] ? { id: rows[0].id, defaultWarehouseId: rows[0].default_warehouse_id } : null;
}

intake.post('/', async (c) => {
  const retryAfter = rateLimited(clientIp((n) => c.req.header(n)));
  if (retryAfter !== null) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'too many submissions, try again shortly' }, 429);
  }

  // JSON for a photo-less lot, multipart when photos ride along.
  let raw: unknown;
  let form: FormData | null = null;
  const ctype = c.req.header('content-type') ?? '';
  if (ctype.startsWith('multipart/form-data')) {
    form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: 'malformed multipart body' }, 400);
    const p = form.get('payload');
    if (typeof p !== 'string') return c.json({ error: 'payload field is required' }, 400);
    try { raw = JSON.parse(p); } catch { return c.json({ error: 'payload must be JSON' }, 400); }
  } else {
    raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json({ error: 'JSON body required' }, 400);
  }

  const parsed = parsePayload(raw);
  if ('honeypot' in parsed) return c.json({ ref: null }, 200);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const payload = parsed.ok;

  const photos = form ? collectPhotos(form, payload.lines.length) : payload.lines.map(() => []);
  if ('error' in photos) return c.json({ error: photos.error }, 400);
  for (let i = 0; i < payload.lines.length; i++) {
    if (unidentified(payload.lines[i], photos[i])) {
      return c.json({ error: `line ${i + 1}: add a photo or at least a part number / capacity` }, 400);
    }
  }

  const sql = getDb(c.env);
  const owner = await resolveOwner(sql, c.env);
  if (!owner) return c.json({ error: 'intake is not configured' }, 503);

  // Same gate as the line-photo route: images only, shrunk to the workspace
  // cap. Uploads happen before the transaction so a failed INSERT can still
  // clean up what reached the bucket.
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  const uploaded: { line: number; file: File; storageKey: string; deliveryUrl: string }[] = [];
  const cleanup = () => deleteAttachments(c.env, uploaded.map(u => u.storageKey))
    .catch(e => log.warn('intake photo cleanup', e));
  const batch = `intake/${new Date().toISOString().slice(0, 7).replace('-', '')}/${crypto.randomUUID()}`;
  for (let i = 0; i < photos.length; i++) {
    for (const file of photos[i]) {
      if (!file.type || !file.type.startsWith('image/') || !allowedMime.has(file.type)) {
        await cleanup();
        return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
      }
      const fitted = await shrinkImageToFit(file, maxBytes);
      if (fitted.size > maxBytes) {
        await cleanup();
        return c.json({ error: `photo too large (max ${maxBytes} bytes)` }, 413);
      }
      try {
        const r = await uploadAttachment(c.env, fitted, batch);
        uploaded.push({ line: i, file: fitted, storageKey: r.storageKey, deliveryUrl: r.deliveryUrl });
      } catch (e) {
        await cleanup();
        if (e instanceof UnsafeMimeError) return c.json({ error: e.message }, 415);
        log.error('intake photo upload', e);
        return c.json({ error: 'upload failed' }, 502);
      }
    }
  }

  const categories = [...new Set(payload.lines.map(l => l.category))];
  const units = payload.lines.reduce((n, l) => n + l.qty, 0);
  const crm = await loadCrmSettings(sql);

  let orderId: string;
  try {
    orderId = await sql.begin(async (tx) => {
      // One house-account supplier per seller. The unique index is on the
      // generated match_key (alnum(name) + zip), so two spellings of one email
      // that normalise the same fall into the same row instead of a 23505.
      const supplier = (await tx<{ id: string }[]>`
        INSERT INTO suppliers (name, email, owner_id, source, status, supplies,
                               next_follow_up_at, created_by)
        VALUES (${payload.email}, ${payload.email}, NULL, ${payload.source}, 'prospect',
                ${categories}, ${isoDatePlus(crm.cadenceDays.prospect)}, ${owner.id})
        ON CONFLICT (owner_id, match_key) DO UPDATE SET last_contacted_at = NOW()
        RETURNING id
      `)[0];

      const notes = [
        `Web intake · cash4ram.com · PayPal ${payload.email}`,
        payload.notes,
      ].filter(Boolean).join('\n');
      const id = await insertDraftOrderTx(tx, {
        ownerId: owner.id,
        actorId: owner.id,
        warehouseId: owner.defaultWarehouseId,
        payment: 'company',
        notes,
        source: payload.source === 'web' ? 'other' : payload.source,
        supplierId: supplier.id,
      });
      // The house owner did not buy this: no commission accrues on it, and
      // the seller asked to be paid by PayPal.
      await tx`
        UPDATE orders SET payment_method = 'paypal', commission_rate = 0 WHERE id = ${id}
      `;

      for (let i = 0; i < payload.lines.length; i++) {
        const l = payload.lines[i];
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
            ${id}, ${category}, ${f.brand ?? null}, ${f.capacity ?? null},
            ${l.category === 'RAM' && f.classification ? RAM_TYPE[f.classification] ?? null : null},
            ${l.category === 'RAM' ? f.classification ?? null : null},
            ${f.rank ?? null}, ${f.speed ?? null},
            ${f.interface ?? null}, ${f.form_factor ?? null}, ${f.description ?? null},
            ${l.category === 'CPU' ? 'CPU' : null}, ${f.part_number ?? null}, 'Pulled — Untested',
            ${l.qty}, 0, 'Draft', ${i}
          )
          RETURNING id
        `)[0];
        await writeOrderEvent(tx, id, owner.id, 'line_added', {
          lineId: row.id, category, partNumber: f.part_number ?? null, qty: l.qty, unitCost: 0,
        });
        let pos = 0;
        for (const u of uploaded.filter(u => u.line === i)) {
          await tx`
            INSERT INTO order_line_photos
              (order_line_id, order_id, filename, size_bytes, mime_type, storage_key, delivery_url, position, uploaded_by)
            VALUES
              (${row.id}::uuid, ${id}, ${u.file.name || 'photo.jpg'}, ${u.file.size},
               ${u.file.type || 'image/jpeg'}, ${u.storageKey}, ${u.deliveryUrl}, ${pos++}, ${owner.id})
          `;
        }
      }

      // No autoTrackParts: an anonymous part number must not seed ref_prices.
      await syncOrderCategory(tx, id);
      await syncOrderGoodsTotal(tx, id, true);
      await notifyManagers(tx, {
        kind: 'intake',
        tone: 'pos',
        icon: 'inbox',
        title: `New sell request ${id}`,
        body: `${payload.lines.length} line${payload.lines.length === 1 ? '' : 's'} · ${units} unit${units === 1 ? '' : 's'} · ${payload.email}`,
      });
      return id;
    });
  } catch (e) {
    await cleanup();
    throw e;
  }

  return c.json({ ref: orderId, lines: payload.lines.length, units }, 201);
});

export default intake;
