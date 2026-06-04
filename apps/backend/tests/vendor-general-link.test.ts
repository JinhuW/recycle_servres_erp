import { beforeEach, describe, it, expect } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('vendor general (customer-less) links', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('mints a customer-less link and rotates the prior one', async () => {
    const { token: mgr } = await loginAs(ALEX);

    const first = await api<{ id: string; token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    expect(first.status).toBe(201);
    expect(first.body.token).toBeTruthy();

    const sql = getTestDb();
    const row1 = (await sql`
      SELECT customer_id, active FROM vendor_links WHERE id = ${first.body.id}
    `)[0];
    expect(row1.customer_id).toBeNull();
    expect(row1.active).toBe(true);

    // Regenerate → prior general link deactivated, exactly one active.
    const second = await api<{ id: string; token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    expect(second.status).toBe(201);

    const activeGeneral = await sql`
      SELECT id FROM vendor_links WHERE customer_id IS NULL AND active = TRUE
    `;
    expect(activeGeneral.length).toBe(1);
    expect(activeGeneral[0].id).toBe(second.body.id);
  });

  it('returns the general link under `general`, absent from per-customer items', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await api<{ id: string }>('POST', '/api/customers', {
      token: mgr, body: { name: 'Per-Cust Co' },
    });
    await api('POST', `/api/customers/${cust.body.id}/vendor-link`, { token: mgr });
    const gen = await api<{ id: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });

    const list = await api<{
      items: { customerId: string; link: { id: string } | null }[];
      general: { id: string; token: string; bidCount: number } | null;
    }>('GET', '/api/customers/vendor-links', { token: mgr });

    expect(list.body.general).not.toBeNull();
    expect(list.body.general!.id).toBe(gen.body.id);
    expect(list.body.general!.bidCount).toBe(0);
    // The general link must not appear as a per-customer row.
    expect(list.body.items.some(i => i.link?.id === gen.body.id)).toBe(false);
  });
});
