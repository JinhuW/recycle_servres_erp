import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb } from './helpers/db';
import { multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const fixture = join(__dirname, 'fixtures', 'invoice.pdf');

// SKIPPED (reconciliation Task 4): /api/attachments is intentionally NOT
// ported. Main has a superior real implementation (r2.ts + the
// sell_order_status_attachments flow); the parallel attachments route is a
// metadata-only stub. See docs/superpowers/plans/2026-05-15-backend-line-reconciliation.md.
describe.skip('POST /api/attachments', () => {
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
});
