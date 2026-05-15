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

  it('returns DB-backed categories with id/label/enabled', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/lookups', { token });
    expect(r.status).toBe(200);
    expect(r.body.categories).toBeInstanceOf(Array);
    const ram = r.body.categories.find((x: { id: string }) => x.id === 'RAM');
    expect(ram).toMatchObject({ id: 'RAM', label: 'RAM', enabled: true });
    // disabled categories (e.g. CPU) are still returned so the UI can show them
    expect(r.body.categories.some((x: { id: string }) => x.id === 'CPU')).toBe(true);
  });
});
