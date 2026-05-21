import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('vendor links CRUD', () => {
  beforeAll(async () => { await resetDb(); });

  async function aCustomer(mgr: string): Promise<string> {
    const r = await api<{ id: string }>('POST', '/api/customers', {
      token: mgr, body: { name: 'Vendor Co', shortName: 'VendCo' },
    });
    return r.body.id;
  }

  it('manager creates and regenerates a link (old token deactivated)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await aCustomer(mgr);
    const a = await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
    expect(a.status).toBe(201);
    const b = await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
    expect(b.body.token).not.toBe(a.body.token);
    const old = await api('GET', `/api/public/vendor/${a.body.token}/me`);
    expect(old.status).toBe(404);
    const cur = await api('GET', `/api/public/vendor/${b.body.token}/me`);
    expect(cur.status).toBe(200);
  });

  it('revoke via PATCH active=false makes the token 404', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await aCustomer(mgr);
    const a = await api<{ id: string; token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
    await api('PATCH', `/api/customers/vendor-link/${a.body.id}`, { token: mgr, body: { active: false } });
    const r = await api('GET', `/api/public/vendor/${a.body.token}/me`);
    expect(r.status).toBe(404);
  });

  it('non-manager is forbidden', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await aCustomer(mgr);
    const { token: pur } = await loginAs(MARCUS);
    const r = await api('POST', `/api/customers/${cust}/vendor-link`, { token: pur });
    expect(r.status).toBe(403);
  });

  it('GET /vendor-links lists active links per customer (manager only)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const withLink = await aCustomer(mgr);
    await api('POST', `/api/customers/${withLink}/vendor-link`, { token: mgr });
    const withoutLink = await aCustomer(mgr);

    const { token: pur } = await loginAs(MARCUS);
    const denied = await api('GET', '/api/customers/vendor-links', { token: pur });
    expect(denied.status).toBe(403);

    type Item = { customerId: string; link: { id: string } | null };
    const r = await api<{ items: Item[] }>('GET', '/api/customers/vendor-links', { token: mgr });
    expect(r.status).toBe(200);
    const linked   = r.body.items.find(i => i.customerId === withLink);
    const unlinked = r.body.items.find(i => i.customerId === withoutLink);
    expect(linked?.link).not.toBeNull();
    expect(unlinked?.link).toBeNull();
  });
});
