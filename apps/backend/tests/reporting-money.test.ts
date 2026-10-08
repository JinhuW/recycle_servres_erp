import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { firstCustomerId, signOffAll } from './helpers/fixtures';

// The money figures read the right fact: a sale's date is when it became Done,
// a projection is over the PO as bought, a customer's revenue is what sold,
// and a purchaser's client card sums only the POs that purchaser can see.

const userId = async (email: string) =>
  (await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`)[0].id;

async function insertPO(id: string, owner: string, opts: { supplierId?: string | null; lifecycle?: string;
  totalCost?: number | null }, line: { unitCost: number; sellPrice: number; qty: number }) {
  const db = getTestDb();
  await db`
    INSERT INTO orders (id, user_id, supplier_id, category, lifecycle, commission_rate, other_fees, total_cost, created_at)
    VALUES (${id}, ${await userId(owner)}, ${opts.supplierId ?? null}, 'HDD', ${opts.lifecycle ?? 'done'}, 0.5, 0,
            ${opts.totalCost ?? null}, NOW())
  `;
  const [l] = await db<{ id: string }[]>`
    INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, status, position)
    VALUES (${id}, 'HDD', ${line.qty}, ${line.unitCost}, ${line.sellPrice}, 'Done', 0) RETURNING id
  `;
  return l.id;
}

async function clearWindow() {
  const db = getTestDb();
  await db`UPDATE orders SET created_at = NOW() - INTERVAL '400 days'`;
  await db`UPDATE sell_orders SET done_at = NOW() - INTERVAL '400 days', created_at = NOW() - INTERVAL '400 days'`;
}

const sellSome = async (token: string, lineId: string, qty: number, to: 'Done' | 'Shipped' = 'Done') => {
  const so = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: { customerId: await firstCustomerId(token),
      lines: [{ inventoryId: lineId, category: 'HDD', label: 'x', partNumber: 'PN', qty, unitPrice: 100 }] },
  });
  expect(so.status).toBe(201);
  if (to === 'Done') await signOffAll(so.body.id);
  const r = await api('POST', `/api/sell-orders/${so.body.id}/status`, { token, body: { to, note: 'x' } });
  expect(r.status).toBe(200);
  return so.body.id;
};

type Dash = { kpis: { revenue: number; profit: number; commission: number } };

describe('reporting money', () => {
  beforeEach(async () => { await resetDb(); await clearWindow(); });

  it('dates a sale by when it became Done, not by its last edit', async () => {
    const { token } = await loginAs(ALEX);
    const line = await insertPO('PO-RM-1', MARCUS, {}, { unitCost: 40, sellPrice: 100, qty: 2 });
    const so = await sellSome(token, line, 1);
    const db = getTestDb();
    await db`UPDATE sell_orders SET done_at = NOW() - INTERVAL '45 days', updated_at = NOW() WHERE id = ${so}`;
    const recent = await api<Dash>('GET', '/api/dashboard?range=30d', { token });
    expect(recent.body.kpis.revenue).toBe(0);
    const wide = await api<Dash>('GET', '/api/dashboard?range=90d', { token });
    expect(wide.body.kpis.revenue).toBeCloseTo(100, 2);
  });

  it("keeps a purchaser's projected commission when part of a line sells", async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: pur } = await loginAs(MARCUS);
    const line = await insertPO('PO-RM-2', MARCUS, { lifecycle: 'done' }, { unitCost: 40, sellPrice: 100, qty: 4 });
    const before = (await api<Dash>('GET', '/api/dashboard?range=7d', { token: pur })).body.kpis;
    expect(before.commission).toBeCloseTo((100 - 40) * 4 * 0.5, 2);
    await sellSome(mgr, line, 1);
    const after = (await api<Dash>('GET', '/api/dashboard?range=7d', { token: pur })).body.kpis;
    expect(after).toEqual(before);
  });

  it("counts a customer's revenue from Done orders and what is owed from committed ones", async () => {
    const { token } = await loginAs(ALEX);
    const customerId = await firstCustomerId(token);
    const baseline = (await api<{ items: { id: string; lifetime_revenue: number; outstanding: number }[] }>(
      'GET', '/api/customers', { token })).body.items.find((x) => x.id === customerId)!;
    const a = await insertPO('PO-RM-3', MARCUS, {}, { unitCost: 10, sellPrice: 100, qty: 10 });
    await sellSome(token, a, 2, 'Done');     // +200 revenue
    await sellSome(token, a, 3, 'Shipped');  // +300 owed
    const draft = await api<{ id: string }>('POST', '/api/sell-orders', {   // neither
      token, body: { customerId, lines: [{ inventoryId: a, category: 'HDD', label: 'x', partNumber: 'PN', qty: 1, unitPrice: 100 }] },
    });
    expect(draft.status).toBe(201);
    const row = (await api<{ items: { id: string; lifetime_revenue: number; outstanding: number }[] }>(
      'GET', '/api/customers', { token })).body.items.find((x) => x.id === customerId)!;
    expect(row.lifetime_revenue - baseline.lifetime_revenue).toBeCloseTo(200, 2);
    expect(row.outstanding - baseline.outstanding).toBeCloseTo(300, 2);
  });

  it("sums only the purchaser's own POs on their client's card", async () => {
    const db = getTestDb();
    const [sup] = await db<{ id: string }[]>`
      INSERT INTO suppliers (name, owner_id, status) VALUES ('Shared Seller', ${await userId(MARCUS)}, 'active') RETURNING id`;
    await insertPO('PO-RM-4', MARCUS, { supplierId: sup.id, totalCost: 100 }, { unitCost: 100, sellPrice: 150, qty: 1 });
    await insertPO('PO-RM-5', PRIYA, { supplierId: sup.id, totalCost: 500 }, { unitCost: 500, sellPrice: 600, qty: 1 });
    type List = { items: { id: string; poCount: number; spendTotal: number }[] };
    const { token: pur } = await loginAs(MARCUS);
    const mine = (await api<List>('GET', '/api/suppliers?status=all', { token: pur })).body.items.find((s) => s.id === sup.id)!;
    expect(mine).toMatchObject({ poCount: 1, spendTotal: 100 });
    const { token: mgr } = await loginAs(ALEX);
    const all = (await api<List>('GET', '/api/suppliers?status=all', { token: mgr })).body.items.find((s) => s.id === sup.id)!;
    expect(all).toMatchObject({ poCount: 2, spendTotal: 600 });
  });
});
