import { Hono } from 'hono';
import { getDb } from '../db';
import { uploadLabelImage } from '../images';
import { scanLabel } from '../ai';
import type { Env, LineCategory, User } from '../types';

const scan = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Single endpoint: receive a multipart upload, push the image to Cloudflare
// Images, run OCR, persist a label_scan row, return the extraction. The
// camera flow on phone calls this once per shot.
scan.post('/label', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);

  const file = form.get('file');
  const category = (form.get('category') as string | null) as LineCategory | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  if (!category || !['RAM', 'SSD', 'Other'].includes(category)) {
    return c.json({ error: 'category must be RAM | SSD | Other' }, 400);
  }

  // Upload first, then OCR. If upload fails the user retries with the same
  // shot — no orphan rows in the DB.
  const uploaded = await uploadLabelImage(c.env, file).catch((e) => {
    console.error('upload error', e);
    return null;
  });
  if (!uploaded) return c.json({ error: 'image upload failed' }, 502);

  const bytes = await file.arrayBuffer();
  const result = await scanLabel(c.env, category, bytes);

  await sql`
    INSERT INTO label_scans (user_id, cf_image_id, delivery_url, category, extracted, confidence, provider)
    VALUES (
      ${u.id}, ${uploaded.imageId}, ${uploaded.deliveryUrl}, ${category},
      ${sql.json(result.fields)}, ${result.confidence}, ${result.provider}
    )
  `;

  return c.json({
    imageId: uploaded.imageId,
    deliveryUrl: uploaded.deliveryUrl,
    extracted: result.fields,
    confidence: result.confidence,
    provider: result.provider,
  });
});

export default scan;
