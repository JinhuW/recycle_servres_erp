import { Hono } from 'hono';
import { getDb } from '../db';
import { uploadAttachment } from '../r2';
import { scanLabel } from '../ai';
import { normalizeFields } from '../ai/normalize';
import { EXPECTED_FIELDS_BY_CATEGORY } from '../ai/prompts';
import { appendErrorRecord } from '../lib/error-log';
import { getUploadLimits } from '../lib/settings';
import type { Env, LineCategory, User } from '../types';

const scan = new Hono<{ Bindings: Env; Variables: { user: User; requestId: string } }>();

// Per-user sliding-window rate limit: max 20 scans per 60-second window.
// Keys are user IDs; values are arrays of timestamps (ms) for recent calls.
const scanTimestamps = new Map<string, number[]>();
const SCAN_WINDOW_MS = 60_000;
const SCAN_MAX = 20;

// Single endpoint: receive a multipart upload, store the image in R2 (same
// bucket as sell-order attachments, under a label-scans/ prefix), run OCR,
// persist a label_scan row, return the extraction. The camera flow on phone
// calls this once per shot.
scan.post('/label', async (c) => {
  const u = c.var.user;

  // Rate-limit check: slide the window forward, then count.
  const now = Date.now();
  const cutoff = now - SCAN_WINDOW_MS;
  const prev = (scanTimestamps.get(u.id) ?? []).filter(t => t > cutoff);
  if (prev.length >= SCAN_MAX) {
    const retryAfter = Math.ceil((prev[0]! - cutoff) / 1000);
    return c.json(
      { error: 'Too many scans, please wait.' },
      429,
      { 'Retry-After': String(retryAfter) },
    );
  }
  prev.push(now);
  scanTimestamps.set(u.id, prev);
  const sql = getDb(c.env);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);

  // workers-types models FormData.get as string|null; a file field is a File
  // at runtime. Cast to the object type so `instanceof` is valid, then keep
  // the runtime check to reject string/missing values.
  const file = form.get('file') as File | null;
  const category = (form.get('category') as string | null) as LineCategory | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  if (!category || !['RAM', 'SSD', 'HDD', 'Other'].includes(category)) {
    return c.json({ error: 'category must be RAM | SSD | HDD | Other' }, 400);
  }

  // Reject unscannable / abusive uploads BEFORE touching R2 or the LLM. This
  // is a camera label flow so only images are allowed (the workspace MIME
  // allowlist may also permit PDFs for sell-order attachments — filter those
  // out here). Size cap is the workspace-configurable upload_max_bytes.
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  const imageMime = new Set([...allowedMime].filter(m => m.startsWith('image/')));
  const mime = file.type || '';
  if (!imageMime.has(mime)) {
    return c.json({ error: `unsupported image type: ${mime || 'unknown'}` }, 415);
  }
  if (file.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  // Upload first, then OCR. If upload fails the user retries with the same
  // shot — no orphan rows in the DB.
  const uploaded = await uploadAttachment(c.env, file, 'label-scans').catch((e) => {
    console.error('label image upload error', e);
    return null;
  });
  if (!uploaded) return c.json({ error: 'image upload failed' }, 502);

  // Without R2 configured the helper returns a usable-looking data: URL; keep
  // the frontend's placeholder filter working by normalising the stub to the
  // shape it already ignores (data:image/placeholder...).
  const deliveryUrl = uploaded.provider === 'stub'
    ? `data:image/placeholder;name=${uploaded.storageKey}`
    : uploaded.deliveryUrl;

  const bytes = await file.arrayBuffer();
  let result;
  try {
    result = await scanLabel(c.env, category, bytes);
  } catch (e) {
    console.error('ocr error', e);
    return c.json({ error: 'label OCR failed — retry the shot' }, 502);
  }

  // Canonicalise to the catalog vocabulary before it is stored or returned —
  // otherwise near-miss values ("32 GB", "4800 MT/s", generation-in-`type`)
  // never match a UI dropdown and silently vanish from the form.
  // Then allowlist the keys: whatever extra keys the model invents must not
  // reach the DB or the prefill payload.
  result.fields = Object.fromEntries(
    Object.entries(normalizeFields(category, result.fields)).filter(([k]) =>
      EXPECTED_FIELDS_BY_CATEGORY[category].includes(k),
    ),
  );

  // Partial-fill detection. If the model skipped any expected field for this
  // category, log a warn record to errors.jsonl so an operator can grep for
  // "scan partial fill" and pull the matching image + extraction to see what
  // the OCR struggled with (e.g. speed missing on a SK Hynix SODIMM).
  // Skip the stub provider: it fills almost nothing by design, so on a deploy
  // missing OPENROUTER_API_KEY it would log on every scan and rotate genuine
  // 500 records out of the shared sink.
  const expected = EXPECTED_FIELDS_BY_CATEGORY[category];
  const missing = expected.filter((f) => !result.fields[f] || result.fields[f].trim() === '');
  if (missing.length > 0 && result.provider !== 'stub') {
    const dir = process.env.ERROR_LOG_DIR;
    if (dir) {
      const requestId = c.var.requestId ?? 'unknown';
      const url = new URL(c.req.url);
      void appendErrorRecord(dir, {
        ts: new Date().toISOString(),
        requestId,
        level: 'warn',
        method: c.req.method,
        path: url.pathname,
        userId: u.id,
        userEmail: u.email,
        message: `scan partial fill: ${missing.length}/${expected.length} field(s) missing (${missing.join(', ')})`,
        context: {
          category,
          missing,
          extracted: result.fields,
          confidence: result.confidence,
          provider: result.provider,
          storageKey: uploaded.storageKey,
          deliveryUrl,
        },
      });
    }
  }

  await sql`
    INSERT INTO label_scans (user_id, cf_image_id, delivery_url, category, extracted, confidence, provider)
    VALUES (
      ${u.id}, ${uploaded.storageKey}, ${deliveryUrl}, ${category},
      ${sql.json(result.fields)}, ${result.confidence}, ${result.provider}
    )
  `;

  return c.json({
    imageId: uploaded.storageKey,
    deliveryUrl,
    extracted: result.fields,
    confidence: result.confidence,
    provider: result.provider,
  });
});

export default scan;
