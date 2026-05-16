import { Hono } from 'hono';
import { getDb } from '../db';
import { uploadAttachment } from '../r2';
import { scanLabel } from '../ai';
import type { Env, LineCategory, User } from '../types';

const scan = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Single endpoint: receive a multipart upload, store the image in R2 (same
// bucket as sell-order attachments, under a label-scans/ prefix), run OCR,
// persist a label_scan row, return the extraction. The camera flow on phone
// calls this once per shot.
scan.post('/label', async (c) => {
  const u = c.var.user;
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
