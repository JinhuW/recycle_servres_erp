import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// "A PO cannot be submitted without a cost" — enforced in advanceOrderTx so
// every door out of Draft is covered, and read off orders.total_cost, which is
// the goods figure every line write re-derives (or the negotiated lot price).
// Per order, not per line: a $0 line thrown in with a priced lot stays legal.
// First submission only: a PO that already left Draft once re-submits as it
// was accepted, so the $0 POs from before the rule are not stuck by an edit.

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

  // A PO submitted before the rule existed: pushed past Draft underneath the
  // guard, as those were. The first case above is the counterpart — the same
  // $0 Draft with no history is still refused.
  async function legacySubmitted(token: string): Promise<{ id: string; lineId: string }> {
    const id = await createOrder(token);
    const sql = getTestDb();
    await sql`UPDATE orders SET lifecycle = 'in_transit' WHERE id = ${id}`;
    await sql`UPDATE order_lines SET status = 'In Transit' WHERE order_id = ${id}`;
    return { id, lineId: (await readOrder(token, id)).lines[0].id };
  }

  it('lets a $0 PO that already left Draft re-submit after an edit sent it back', async () => {
    const { token } = await loginAs(MARCUS);
    const { id, lineId } = await legacySubmitted(token);

    // A material purchaser edit reverts the PO to Draft, cost still $0.
    expect((await api('PATCH', `/api/orders/${id}`, {
      token, body: { lines: [{ id: lineId, qty: 3 }] },
    })).status).toBe(200);
    expect((await readOrder(token, id)).lifecycle).toBe('draft');

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect((await readOrder(token, id)).lifecycle).toBe('in_transit');
  });

  it('lets a manager stage-jump such a PO forward as well', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { id, lineId } = await legacySubmitted(pTok);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pTok, body: { lines: [{ id: lineId, qty: 3 }] },
    })).status).toBe(200);

    const { token: mTok } = await loginAs(ALEX);
    const r = await api('POST', `/api/orders/${id}/advance`, {
      token: mTok, body: { toStage: 'in_transit' },
    });
    expect(r.status).toBe(200);
    expect((await readOrder(pTok, id)).lifecycle).toBe('in_transit');
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
