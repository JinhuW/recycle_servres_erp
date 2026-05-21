import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { UPLOAD_HARD_CAP_BYTES } from '../src/lib/settings';

// H4 regression: upload_max_bytes accepted ANY positive integer, so a manager
// could set an unbounded cap and a single oversized upload (buffered fully by
// c.req.formData()) would OOM the container. The setting must be clamped to an
// absolute hard ceiling.

describe('PATCH /api/workspace — upload_max_bytes ceiling', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects an upload_max_bytes above the absolute hard cap', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/workspace', {
      token, body: { upload_max_bytes: UPLOAD_HARD_CAP_BYTES + 1 },
    });
    expect(r.status).toBe(400);
  });

  it('accepts an upload_max_bytes at or below the hard cap', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/workspace', {
      token, body: { upload_max_bytes: UPLOAD_HARD_CAP_BYTES },
    });
    expect(r.status).toBe(200);
  });
});
