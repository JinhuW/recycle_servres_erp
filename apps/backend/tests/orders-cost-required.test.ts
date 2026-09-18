import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// "A PO cannot be submitted without a cost" — enforced in advanceOrderTx so
// every door out of Draft is covered, and read off orders.total_cost, which is
// the goods figure every line write re-derives (or the negotiated lot price).
// Per order, not per line: a $0 line thrown in with a priced lot stays legal.

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 2, unitCost: 0,
};

type CreateOpts = { lines?: Array<typeof LINE>; totalCost?: number };

// The transaction id satisfies the company-pay rule, so a refusal here can
// only be the cost rule.
async function createOrder(token: string, opts: CreateOpts = {}): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      paypalTxnId: '7AB12345CD678901E',
      lines: opts.lines ?? [LINE],
      ...(opts.totalCost !== undefined ? { totalCost: opts.totalCost } : {}),
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function readOrder(token: string, id: string) {
  const got = await api<{ order: { lifecycle: string; totalCost: number | null; lines: { id: string }[] } }>(
    'GET', `/api/orders/${id}`, { token });
  expect(got.status).toBe(200);
  return got.body.order;
}

describe('a PO needs a goods cost to leave Draft', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses the advance and leaves the PO in Draft', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token);

    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cost/i);
    expect((await readOrder(token, id)).lifecycle).toBe('draft');
  });

  it('refuses the hand-off with the same rule', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token);

    const r = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, {
      token,
      body: {
        warehouseId: 'WH-LA1', source: 'facebook',
        handoff: { method: 'pickup', byUserId: user.id },
        payment: 'company', paymentMethod: 'cash',
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cost/i);
    expect((await readOrder(token, id)).lifecycle).toBe('draft');
  });

  it('holds a manager stage-jump to the same rule', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await createOrder(pTok);

    const { token: mTok } = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, {
      token: mTok, body: { toStage: 'done' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cost/i);
    expect((await readOrder(mTok, id)).lifecycle).toBe('draft');
  });

  it('refuses the empty draft shell, before the transaction-id rule', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders/draft', {
      token, body: { category: 'RAM' },
    });
    expect(created.status).toBe(201);

    const r = await api<{ error: string }>('POST', `/api/orders/${created.body.id}/advance`, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cost/i);
    expect(r.body.error).not.toMatch(/transaction/i);
  });

  it('advances once a unit cost is saved on a line', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token);
    const lineId = (await readOrder(token, id)).lines[0].id;

    const patched = await api('PATCH', `/api/orders/${id}`, {
      token, body: { lines: [{ id: lineId, unitCost: 60 }] },
    });
    expect(patched.status).toBe(200);
    expect((await readOrder(token, id)).totalCost).toBe(120);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect((await readOrder(token, id)).lifecycle).toBe('in_transit');
  });

  it('lets a $0 line ride along in a priced lot', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, {
      lines: [{ ...LINE, unitCost: 45 }, { ...LINE, partNumber: 'M393A4K40DB2-CVF' }],
    });

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect((await readOrder(token, id)).lifecycle).toBe('in_transit');
  });

  it('accepts a negotiated lot price over $0 lines', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, { totalCost: 500 });
    expect((await readOrder(token, id)).totalCost).toBe(500);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect((await readOrder(token, id)).lifecycle).toBe('in_transit');
  });
});
