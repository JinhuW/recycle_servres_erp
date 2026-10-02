// Unauthenticated website forms, mounted under /api/public/ (CSRF-exempt, see
// csrf.ts):
//   POST /api/public/intake — the ram4cash.com sell form: a lot of RAM/SSD/CPU
//                             lines with label photos (JSON, or multipart
//                             when photos ride along).
//   POST /api/public/quote  — the recycleservers.com /contact quote form.
//
// Both only write a web_submissions row (plus photos) and tell managers. A
// sell lot becomes a Draft PO only when a manager converts it on the Web
// submissions page (routes/webSubmissions.ts), so nothing here touches orders.
//
// There is no credential: the forms are public by design. What stands between
// the internet and the database is the validation below, a per-IP budget, a
// honeypot, and the fact that nothing here reads back anything but the new
// submission's reference.

import { Hono, type MiddlewareHandler } from 'hono';
import { getDb } from '../db';
import { log } from '../lib/log';
import { nextHumanId } from '../lib/id-seq';
import { createRateLimiter } from '../lib/rate-limit';
import { notifyManagers } from '../lib/notify';
import { getUploadLimits } from '../lib/settings';
import { shrinkImageToFit } from '../lib/image-shrink';
import { deleteAttachments, uploadAttachment } from '../r2';
import type { Env } from '../types';

const publicForms = new Hono<{ Bindings: Env }>();

const MAX_LINES = 20;
const MAX_QTY = 9999;
const MAX_TEXT = 120;
const MAX_NOTES = 2000;
const PHOTOS_PER_LINE = 4;
const PHOTOS_PER_REQUEST = 20;
// The file name is the sender's own text, stored as-is for display.
const STORED_FILENAME_MAX = 200;
// Five submissions a minute from one address is generous for a person and
// cheap for a script. One budget across both forms; per-process, the same
// trade-off /api/scan makes.
const rateLimited = createRateLimiter(60_000, 5);

export const SELL_CATEGORIES = ['RAM', 'SSD', 'CPU'] as const;
export type SellCategory = (typeof SELL_CATEGORIES)[number];
export const WEB_CHANNEL_SOURCES = ['web', 'facebook', 'reddit'] as const;
type Source = (typeof WEB_CHANNEL_SOURCES)[number];
const HANDOFFS = ['ship', 'pickup'] as const;
export type Handoff = (typeof HANDOFFS)[number];
// The spec fields the sell form can send, all optional. Anything else is dropped.
export const FIELD_KEYS = [
  'classification', 'capacity', 'speed', 'rank', 'brand',
  'interface', 'form_factor', 'description', 'part_number',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export type SellLine = { category: SellCategory; qty: number; fields: Partial<Record<FieldKey, string>> };
/** What web_submissions.payload holds for a sell lot. */
export type SellLotPayload = {
  email: string;
  notes: string | null;
  source: Source;
  handoff: Handoff;
  pickup_location: string | null;
  lines: SellLine[];
};

/** What web_submissions.payload holds for a quote request. */
export type QuotePayload = {
  customer_type: 'business' | 'individual';
  hardware: string[];
  quantity: string | null;
  condition: string | null;
  data_handling: string | null;
  pickup_method: string | null;
  origin_zip: string | null;
  timeline: string | null;
  name: string;
  company: string | null;
  email: string;
  phone: string | null;
  notes: string | null;
};

type Parsed<T> = { ok: T } | { error: string } | { honeypot: true };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function clientIp(h: (name: string) => string | undefined): string {
  return h('x-forwarded-for')?.split(',')[0]?.trim() || h('x-real-ip') || 'anon';
}

function text(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function email(v: unknown): string | null {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return EMAIL_RE.test(e) && e.length <= MAX_TEXT ? e : null;
}

// A filled honeypot is answered 200 and ignored, so a bot can't tell it was
// caught.
function isHoneypot(b: Record<string, unknown>): boolean {
  return typeof b.website === 'string' && b.website.trim() !== '';
}

export function parseSellLot(raw: unknown): Parsed<SellLotPayload> {
  if (!raw || typeof raw !== 'object') return { error: 'payload must be an object' };
  const b = raw as Record<string, unknown>;
  if (isHoneypot(b)) return { honeypot: true };

  const mail = email(b.email);
  if (!mail) return { error: 'a valid PayPal email is required' };
  if (!Array.isArray(b.lines) || b.lines.length === 0) return { error: 'at least one line is required' };
  if (b.lines.length > MAX_LINES) return { error: `at most ${MAX_LINES} lines per submission` };

  const lines: SellLine[] = [];
  for (let i = 0; i < b.lines.length; i++) {
    const l = b.lines[i] as Record<string, unknown> | null;
    if (!l || typeof l !== 'object') return { error: `line ${i + 1}: must be an object` };
    if (!SELL_CATEGORIES.includes(l.category as SellCategory)) {
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
    lines.push({ category: l.category as SellCategory, qty, fields });
  }

  // Optional with a default: a bundle cached from before the site asked how
  // the lot changes hands still posts.
  const handoff = HANDOFFS.includes(b.handoff as Handoff) ? (b.handoff as Handoff) : 'ship';
  const pickup = handoff === 'pickup' ? text(b.pickup_location, 40) : null;
  if (handoff === 'pickup' && !pickup) return { error: 'pick a pickup city' };

  return {
    ok: {
      email: mail,
      notes: text(b.notes, MAX_NOTES),
      source: WEB_CHANNEL_SOURCES.includes(b.source as Source) ? (b.source as Source) : 'web',
      handoff,
      pickup_location: pickup,
      lines,
    },
  };
}

export function parseQuote(raw: unknown): Parsed<QuotePayload> {
  if (!raw || typeof raw !== 'object') return { error: 'body must be an object' };
  const b = raw as Record<string, unknown>;
  if (isHoneypot(b)) return { honeypot: true };

  const name = text(b.name);
  if (!name) return { error: 'name is required' };
  const mail = email(b.email);
  if (!mail) return { error: 'a valid email is required' };
  const customerType = b.customer_type === 'individual' ? 'individual' : 'business';
  const company = text(b.company);
  if (customerType === 'business' && !company) return { error: 'company is required for a business' };
  const phone = text(b.phone, 40);
  if (phone && !/^[\d\s()+\-.]{7,}$/.test(phone)) return { error: 'phone number looks invalid' };

  // The form sends the hardware picks as names; older builds sent one
  // comma-joined string.
  const hwRaw: unknown[] = Array.isArray(b.hardware)
    ? b.hardware
    : typeof b.hardware === 'string' ? b.hardware.split(',') : [];
  const hardware = hwRaw.map(h => text(h, 60)).filter((h): h is string => !!h).slice(0, 20);
  if (hardware.length === 0) return { error: 'pick at least one hardware type' };

  return {
    ok: {
      customer_type: customerType,
      hardware,
      quantity: text(b.quantity, 40),
      condition: text(b.condition, 40),
      data_handling: text(b.data_handling, 40),
      pickup_method: text(b.pickup_method, 40),
      origin_zip: text(b.origin_zip, 20),
      timeline: text(b.timeline, 40),
      name,
      company,
      email: mail,
      phone,
      notes: text(b.notes, MAX_NOTES),
    },
  };
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
function unidentified(l: SellLine, photos: File[]): boolean {
  return photos.length === 0 && !l.fields.part_number && !l.fields.capacity && !l.fields.description;
}

// Scoped to the two form paths: this sub-app is mounted at /api/public, and a
// '*' here would also throttle the Shippo webhook.
const limit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const retryAfter = rateLimited(clientIp((n) => c.req.header(n)));
  if (retryAfter !== null) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'too many submissions, try again shortly' }, 429);
  }
  return next();
};
publicForms.use('/intake', limit);
publicForms.use('/quote', limit);

publicForms.post('/intake', async (c) => {
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

  const parsed = parseSellLot(raw);
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

  // Same gate as the line-photo route: images only, shrunk to the workspace
  // cap. Uploads happen before the transaction so a failed INSERT can still
  // clean up what reached the bucket.
  const sql = getDb(c.env);
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  const uploaded: { line: number; pos: number; file: File; storageKey: string; deliveryUrl: string }[] = [];
  const cleanup = () => deleteAttachments(c.env, uploaded.map(u => u.storageKey))
    .catch(e => log.warn('intake photo cleanup', e));
  const batch = `web-submissions/${new Date().toISOString().slice(0, 7).replace('-', '')}/${crypto.randomUUID()}`;
  for (let i = 0; i < photos.length; i++) {
    for (let n = 0; n < photos[i].length; n++) {
      const file = photos[i][n];
      if (!file.type || !file.type.startsWith('image/') || !allowedMime.has(file.type)) {
        await cleanup();
        return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
      }
      const fitted = await shrinkImageToFit(file, maxBytes);
      if (fitted.size > maxBytes) {
        await cleanup();
        return c.json({ error: `photo too large (max ${maxBytes} bytes)` }, 413);
      }
      const r = await uploadAttachment(c.env, fitted, batch)
        .catch(e => { log.error('intake photo upload', e); return null; });
      if (!r) {
        await cleanup();
        return c.json({ error: 'upload failed' }, 502);
      }
      uploaded.push({ line: i, pos: n, file: fitted, storageKey: r.storageKey, deliveryUrl: r.deliveryUrl });
    }
  }

  const units = payload.lines.reduce((n, l) => n + l.qty, 0);
  let ref: string;
  try {
    ref = await sql.begin(async (tx) => {
      const id = await nextHumanId(tx, 'WS', 'WS');
      await tx`
        INSERT INTO web_submissions (id, site, kind, email, notes, source, payload, ip, user_agent)
        VALUES (${id}, 'ram4cash', 'sell_lot', ${payload.email}, ${payload.notes}, ${payload.source},
                ${tx.json(payload as never)}, ${clientIp((n) => c.req.header(n))},
                ${text(c.req.header('user-agent'), 300)})
      `;
      for (const u of uploaded) {
        await tx`
          INSERT INTO web_submission_photos
            (submission_id, line_index, filename, size_bytes, mime_type, storage_key, delivery_url, position)
          VALUES (${id}, ${u.line}, ${(u.file.name || 'photo.jpg').slice(0, STORED_FILENAME_MAX)}, ${u.file.size},
                  ${u.file.type || 'image/jpeg'}, ${u.storageKey}, ${u.deliveryUrl}, ${u.pos})
        `;
      }
      await notifyManagers(tx, {
        kind: 'web_submission',
        tone: 'pos',
        icon: 'mail',
        title: `New sell request ${id} · ram4cash.com`,
        body: `${payload.lines.length} line${payload.lines.length === 1 ? '' : 's'} · ${units} unit${units === 1 ? '' : 's'} · ${payload.email}`,
      });
      return id;
    });
  } catch (e) {
    await cleanup();
    throw e;
  }

  return c.json({ ref, lines: payload.lines.length, units }, 201);
});

publicForms.post('/quote', async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (raw === null) return c.json({ error: 'JSON body required' }, 400);
  const parsed = parseQuote(raw);
  if ('honeypot' in parsed) return c.json({ ref: null }, 200);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const q = parsed.ok;

  const sql = getDb(c.env);
  const ref = await sql.begin(async (tx) => {
    const id = await nextHumanId(tx, 'WS', 'WS');
    await tx`
      INSERT INTO web_submissions (id, site, kind, name, company, email, phone, notes, payload, ip, user_agent)
      VALUES (${id}, 'recycleservers', 'quote', ${q.name}, ${q.company}, ${q.email}, ${q.phone},
              ${q.notes}, ${tx.json(q as never)}, ${clientIp((n) => c.req.header(n))},
              ${text(c.req.header('user-agent'), 300)})
    `;
    await notifyManagers(tx, {
      kind: 'web_submission',
      tone: 'pos',
      icon: 'mail',
      title: `New quote request ${id} · recycleservers.com`,
      body: `${q.name}${q.company ? ` (${q.company})` : ''} · ${q.hardware.join(', ')}`,
    });
    return id;
  });
  return c.json({ ref }, 201);
});

export default publicForms;
