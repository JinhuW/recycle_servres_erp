import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const attachments = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

attachments.post('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const fileRaw = form.get('file') as unknown;
  if (!fileRaw || !(fileRaw instanceof File || fileRaw instanceof Blob)) {
    return c.json({ error: 'file required' }, 400);
  }
  const f = fileRaw as File;
  if (f.size > MAX_BYTES) return c.json({ error: 'file exceeds 10MB' }, 413);
  if (f.type && !ALLOWED_MIME.has(f.type)) return c.json({ error: `mime ${f.type} not allowed` }, 415);

  // v1: store metadata only — actual R2 upload deferred.
  const storageId = 'local/' + crypto.randomUUID();
  const url = `internal://${storageId}`;
  const sql = getDb(c.env);
  const r = await sql<{ id: string }[]>`
    INSERT INTO attachments (storage_id, url, name, size, mime_type, uploaded_by)
    VALUES (${storageId}, ${url}, ${f.name ?? 'upload'}, ${f.size}, ${f.type || 'application/octet-stream'}, ${c.var.user.id})
    RETURNING id
  `;
  return c.json({ id: r[0].id, url, name: f.name ?? 'upload', size: f.size, mimeType: f.type }, 201);
});

attachments.get('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const r = (await sql`SELECT id, url, name, size, mime_type, created_at FROM attachments WHERE id = ${c.req.param('id')} LIMIT 1`)[0];
  if (!r) return c.json({ error: 'Not found' }, 404);
  return c.json({ attachment: r });
});

attachments.delete('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const r = await sql`DELETE FROM attachments WHERE id = ${c.req.param('id')} RETURNING id`;
  if (r.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default attachments;
