import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type OrderSummary = {
  id: string;
  lifecycle: string;
  status: string | null;
  lineCount: number;
};

// Manager scope: drafts are purchaser-in-progress work and should not clutter
// the manager review queue. They become visible only after Draft → In Transit.
// Purchasers continue to see their own drafts (incl. the mobile Draft chip).
describe('GET /api/orders draft visibility', () => {
  beforeEach(async () => { await resetDb(); });

  it('empty draft is hidden from manager list', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders/draft', {
      token: pTok, body: { category: 'RAM' },
    });
    expect(created.status).toBe(201);
    const draftId = created.body.id;

    const { token: mTok } = await loginAs(ALEX);
    const list = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: mTok });
    expect(list.status).toBe(200);
    expect(list.body.orders.find(o => o.id === draftId)).toBeUndefined();
    expect(list.body.orders.every(o => o.lifecycle !== 'draft')).toBe(true);
  });

  it('manager filter ?status=Draft returns no drafts', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const draft = await api<{ id: string }>('POST', '/api/orders/draft', {
      token: pTok, body: { category: 'RAM' },
    });
    expect(draft.status).toBe(201);

    const { token: mTok } = await loginAs(ALEX);
    const list = await api<{ orders: OrderSummary[] }>(
      'GET', '/api/orders?status=Draft', { token: mTok },
    );
    expect(list.status).toBe(200);
    expect(list.body.orders).toEqual([]);
  });

  it('draft with lines is hidden from manager list', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: {
        category: 'RAM',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    const draftId = created.body.id;

    const { token: mTok } = await loginAs(ALEX);
    const list = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: mTok });
    expect(list.body.orders.find(o => o.id === draftId)).toBeUndefined();
  });

  it('purchaser still sees their own drafts (incl. ?status=Draft)', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const draft = await api<{ id: string }>('POST', '/api/orders/draft', {
      token: pTok, body: { category: 'RAM' },
    });
    expect(draft.status).toBe(201);

    const all = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: pTok });
    expect(all.body.orders.find(o => o.id === draft.body.id)).toBeDefined();

    const filtered = await api<{ orders: OrderSummary[] }>(
      'GET', '/api/orders?status=Draft', { token: pTok },
    );
    expect(filtered.body.orders.find(o => o.id === draft.body.id)).toBeDefined();
  });

  it('manager sees the order once purchaser advances Draft → In Transit', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: {
        category: 'RAM',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    const id = created.body.id;
    const adv = await api('POST', `/api/orders/${id}/advance`, { token: pTok });
    expect(adv.status).toBe(200);

    const { token: mTok } = await loginAs(ALEX);
    const list = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: mTok });
    const found = list.body.orders.find(o => o.id === id);
    expect(found).toBeDefined();
    expect(found!.lifecycle).toBe('in_transit');
  });
});
