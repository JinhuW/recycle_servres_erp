import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('GET /api/lookups', () => {
  beforeAll(async () => { await resetDb(); });

  it('returns lookup groups without paymentTerms', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/lookups', { token });
    expect(r.status).toBe(200);
    expect(r.body.priceSources).toBeInstanceOf(Array);
    expect(r.body.sellOrderStatuses).toBeInstanceOf(Array);
    expect(r.body).not.toHaveProperty('paymentTerms');
  });
});
