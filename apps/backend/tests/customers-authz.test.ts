import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('GET /api/customers/ — manager-only', () => {
  beforeAll(async () => { await resetDb(); });

  it('manager gets 200 with items', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: unknown[] }>('GET', '/api/customers', { token });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
  });

  it('purchaser gets 403 from GET /api/customers/', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/customers', { token });
    expect(r.status).toBe(403);
  });
});
