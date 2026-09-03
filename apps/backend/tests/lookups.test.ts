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

  it('exposes ai_capture so the forms can gate the AI scanner per category', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/lookups', { token });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(
      r.body.categories.map((x: { id: string; aiCapture: boolean }) => [x.id, x.aiCapture]),
    );
    expect(byId.RAM).toBe(true);
    expect(byId.SSD).toBe(true);
    expect(byId.HDD).toBe(false);
  });

  // 1024GB is not how these drives are labelled; 1TB replaces it in the same
  // slot so the list still reads in ascending size order.
  it('offers 1TB and not 1024GB in the SSD capacity catalog', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/lookups', { token });
    expect(r.status).toBe(200);
    const caps: string[] = r.body.catalog.SSD_CAP;
    expect(caps).toContain('1TB');
    expect(caps).not.toContain('1024GB');
    expect(caps.indexOf('1TB')).toBe(caps.indexOf('1000GB') + 1);
  });

  // Guards the seed half of the rank list only: the template DB is migrated and
  // then seeded, and the seed deletes catalog_options first — so a value missing
  // from migration 0117 alone would still pass here.
  it('offers the dual-die and 3DS ranks after the plain grid', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/lookups', { token });
    expect(r.status).toBe(200);
    const ranks: string[] = r.body.catalog.RAM_RANK;
    for (const v of ['4DRx4', '8DRx4', '2S2Rx4', '2S4Rx4', '4S2Rx4']) {
      expect(ranks).toContain(v);
      expect(ranks.indexOf(v)).toBeGreaterThan(ranks.indexOf('8Rx8'));
    }
  });
});
