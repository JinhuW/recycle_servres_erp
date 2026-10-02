import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { multipart } from './helpers/app';

describe('POST /api/public/intake photo file names', () => {
  beforeEach(async () => { await resetDb(); });

  it('stores a sender-chosen file name capped at 200 characters', async () => {
    const payload = JSON.stringify({
      email: 'names@example.com', source: 'web', lines: [{ category: 'RAM', qty: 1, fields: {} }],
    });
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], `${'n'.repeat(500)}.jpg`, {
      type: 'image/jpeg',
    });
    // Deliberately no X-Requested-By: the public forms are CSRF-exempt.
    const r = await multipart('/api/public/intake', { payload, 'photo-0-0': photo }, {
      headers: { 'X-Forwarded-For': '203.0.113.201', 'X-Requested-By': '' },
    });
    expect(r.status).toBe(201);
    const ref = (r.body as { ref: string }).ref;
    const [row] = await getTestDb()<{ filename: string }[]>`
      SELECT filename FROM web_submission_photos WHERE submission_id = ${ref}
    `;
    expect(row.filename).toHaveLength(200);
    expect(row.filename).toBe('n'.repeat(200));
  });
});
