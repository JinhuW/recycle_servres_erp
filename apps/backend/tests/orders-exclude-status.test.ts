import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type OrderSummary = { id: string; lifecycle: string };

// The mobile manager view lists the whole org but hides finished POs by
// default via excludeStatus=Done; the Done chip flips to status=Done instead.
describe('GET /api/orders excludeStatus', () => {
  beforeEach(async () => { await resetDb(); });

  async function createPO(token: string): Promise<string> {
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        paypalTxnId: 'TESTPAYTXN0000001',
        category: 'RAM',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    expect(r.status).toBe(201);
    return r.body.id;
  }

  it('excludeStatus=Done drops finished POs but keeps the rest, org-wide', async () => {
    const { token: purchaser } = await loginAs(MARCUS);
    const draftPo = await createPO(purchaser);

    const { token: mgr } = await loginAs(ALEX);
    const donePo = await createPO(mgr);
    const adv = await api('POST', `/api/orders/${donePo}/advance`, {
      token: mgr, body: { toStage: 'done' },
    });
    expect(adv.status).toBe(200);

    // Default manager list is org-wide and includes Done.
    const all = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: mgr });
    expect(all.status).toBe(200);
    expect(all.body.orders.map(o => o.id)).toEqual(expect.arrayContaining([draftPo, donePo]));

    // The seed ships its own backlog of orders, so assert membership and
    // lifecycles rather than exact lists (limit=200 covers the whole set).
    const filtered = await api<{ orders: OrderSummary[] }>(
      'GET', '/api/orders?excludeStatus=Done&limit=200', { token: mgr });
    expect(filtered.status).toBe(200);
    const ids = filtered.body.orders.map(o => o.id);
    expect(ids).toContain(draftPo);
    expect(ids).not.toContain(donePo);
    expect(filtered.body.orders.every(o => o.lifecycle !== 'done')).toBe(true);

    // The Done chip still reaches finished POs via the positive filter.
    const doneOnly = await api<{ orders: OrderSummary[] }>(
      'GET', '/api/orders?status=Done&limit=200', { token: mgr });
    const doneIds = doneOnly.body.orders.map(o => o.id);
    expect(doneIds).toContain(donePo);
    expect(doneOnly.body.orders.every(o => o.lifecycle === 'done')).toBe(true);
  });

  it('an unknown label excludes nothing', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const po = await createPO(mgr);

    const r = await api<{ orders: OrderSummary[] }>(
      'GET', '/api/orders?excludeStatus=Bogus', { token: mgr });
    expect(r.status).toBe(200);
    expect(r.body.orders.map(o => o.id)).toContain(po);
  });
});
