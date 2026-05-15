import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb } from './helpers/db';
import { multipart, api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const fixture = join(__dirname, 'fixtures', 'invoice.pdf');

describe('POST /api/attachments', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager can upload a PDF', async () => {
    const { token } = await loginAs(ALEX);
    const file = new Blob([readFileSync(fixture)], { type: 'application/pdf' });
    const r = await multipart('/api/attachments', { file }, { token });
    expect(r.status).toBe(201);
    const b = r.body as { id: string; name: string; size: number; mimeType: string };
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.mimeType).toBe('application/pdf');
    expect(b.size).toBeGreaterThan(0);
  });

  it('purchaser is forbidden', async () => {
    const { token } = await loginAs(MARCUS);
    const file = new Blob([readFileSync(fixture)], { type: 'application/pdf' });
    const r = await multipart('/api/attachments', { file }, { token });
    expect(r.status).toBe(403);
  });

  it('rejects oversize files (>10MB)', async () => {
    const { token } = await loginAs(ALEX);
    const big = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'application/pdf' });
    const r = await multipart('/api/attachments', { file: big }, { token });
    expect(r.status).toBe(413);
  });

  it('honours a workspace-configured upload_max_bytes', async () => {
    const { token } = await loginAs(ALEX);
    const w = await api('PATCH', '/api/workspace', { token, body: { upload_max_bytes: 100 } });
    expect(w.status).toBe(200);
    const file = new Blob([readFileSync(fixture)], { type: 'application/pdf' });
    const r = await multipart('/api/attachments', { file }, { token });
    expect(r.status).toBe(413);
  });
});
