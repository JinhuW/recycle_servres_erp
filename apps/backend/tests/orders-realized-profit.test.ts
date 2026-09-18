// A PO's realized profit: what its units earned on Done sell orders, at the
// sell-order price less what the unit cost — its share of a negotiated lot
// price when the header states one, else its unit cost, plus the fee share —
// net of the commission actually paid: the purchaser's projected commission
// on the PO as bought, over priced lines, as the dashboard shows it. Managers
// only; null until something sells. The projection (`profit`) is untouched by
// any of it.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Realized = {
  soldQty: number; boughtQty: number; revenue: number; cost: number;
  grossProfit: number; commission: number; profit: number;
};
type Detail = { order: { id: string; profit?: number; realized: Realized | null; lines: { id: string; qty: number }[] } };
type List = { orders: { id: string; profit: number; realized?: Realized | null }[] };

const PN = 'RZP-TEST-PN';
const FEES = 20;
const RATE = 0.1;
// Line A: 4 × $78.50 projected at $120; line B: 2 × $40 projected at $60.
const LINES = [
  { qty: 4, unitCost: 78.5, sellPrice: 120 },
  { qty: 2, unitCost: 40, sellPrice: 60 },
];
const GOODS = LINES.reduce((s, l) => s + l.qty * l.unitCost, 0);          // 394
const PROJECTED = LINES.reduce((s, l) => s + l.qty * l.sellPrice, 0);     // 600
const COMMISSION = (PROJECTED - GOODS - FEES) * RATE;                     // 18.60
// Other fees amortize cost-weighted over the PO as bought.
const eff = (unitCost: number) => unitCost * (1 + FEES / GOODS);

type Line = { qty: number; unitCost: number; sellPrice: number | null };

async function createReviewing(
  pur: string, mgr: string, lines: Line[] = LINES, totalCost?: number,
): Promise<{ id: string; lineIds: string[] }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000004',
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      // A stated total pins a negotiated lot price against the lines.
      ...(totalCost !== undefined ? { totalCost } : {}),
      lines: lines.map((l, i) => ({
        category: 'RAM', brand: 'Samsung', capacity: i === 0 ? '32GB' : '16GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200', partNumber: PN, condition: 'Pulled — Tested',
        qty: l.qty, unitCost: l.unitCost, sellPrice: l.sellPrice,
      })),
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, {
    token: mgr, body: { toStage: 'reviewing' },
  })).status).toBe(200);
  expect((await api('PATCH', `/api/orders/${id}`, {
    token: mgr, body: { commissionRate: RATE, otherFees: FEES },
  })).status).toBe(200);
  const got = await api<Detail>('GET', `/api/orders/${id}`, { token: mgr });
  return { id, lineIds: got.body.order.lines.map(l => l.id) };
}

async function detail(id: string, token: string): Promise<Detail['order']> {
  const res = await api<Detail>('GET', `/api/orders/${id}`, { token });
  expect(res.status).toBe(200);
  return res.body.order;
}

async function listed(id: string, token: string): Promise<List['orders'][number]> {
  const res = await api<List>('GET', '/api/orders?status=Reviewing', { token });
  expect(res.status).toBe(200);
  const row = res.body.orders.find(o => o.id === id);
  expect(row).toBeDefined();
  return row!;
}

async function createSellOrderOn(mgr: string, lineId: string, qty: number, unitPrice: number): Promise<string> {
  const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token: mgr });
  const so = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: mgr,
    body: {
      customerId: customers.body.items[0].id,
      lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: PN, qty, unitPrice }],
    },
  });
  expect(so.status).toBe(201);
  return so.body.id;
}

async function moveSellOrder(mgr: string, soId: string, to: string): Promise<void> {
  const body = to === 'Closed' ? { to, note: 'x', closeReasonId: 'customer_cancelled' } : { to, note: 'x' };
  expect((await api('POST', `/api/sell-orders/${soId}/status`, { token: mgr, body })).status).toBe(200);
}

describe('realized profit on POs', () => {
  beforeEach(async () => { await resetDb(); });

  it('is null on the list and the detail until a sell order is Done; Shipped and Closed do not count', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);

    expect((await detail(id, mgr)).realized).toBeNull();
    expect((await listed(id, mgr)).realized).toBeNull();

    const shipped = await createSellOrderOn(mgr, lineIds[0], 1, 130);
    await moveSellOrder(mgr, shipped, 'Shipped');
    const cancelled = await createSellOrderOn(mgr, lineIds[0], 1, 500);
    await moveSellOrder(mgr, cancelled, 'Closed');
    expect((await detail(id, mgr)).realized).toBeNull();
    expect((await listed(id, mgr)).realized).toBeNull();

    await moveSellOrder(mgr, shipped, 'Done');
    const r = (await detail(id, mgr)).realized!;
    expect(r.soldQty).toBe(1);
    expect(r.revenue).toBe(130);
  });

  it('nets the commission actually paid from what the units earned, identically on list and detail', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);

    // Line A sells one of four (partial); line B sells out.
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[0], 1, 130), 'Done');
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[1], 2, 55), 'Done');

    const revenue = 130 + 2 * 55;
    const cost = eff(78.5) + 2 * eff(40);
    const gross = revenue - cost;

    const fromDetail = await detail(id, mgr);
    const r = fromDetail.realized!;
    expect(r.soldQty).toBe(3);
    expect(r.boughtQty).toBe(6);
    expect(r.revenue).toBeCloseTo(revenue, 2);
    expect(r.cost).toBeCloseTo(cost, 2);
    expect(r.grossProfit).toBeCloseTo(gross, 2);
    expect(r.commission).toBeCloseTo(COMMISSION, 2);
    expect(r.profit).toBeCloseTo(gross - COMMISSION, 2);

    const fromList = await listed(id, mgr);
    expect(fromList.realized).toEqual(r);
    // The projection is a different figure and is not touched by sales.
    expect(fromList.profit).toBeCloseTo(
      (4 - 1) * (120 - 78.5) + 2 * (60 - 40) - FEES, 2,
    );
  });

  it('keeps an earlier sale\'s cost fixed when a sibling line later sells partially', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);

    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[1], 2, 55), 'Done');
    const before = (await detail(id, mgr)).realized!;
    expect(before.cost).toBeCloseTo(2 * eff(40), 2);

    // A partial sale on line A decrements its qty. The fee basis must not
    // follow it, or line B's already-sold units would get dearer.
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[0], 1, 130), 'Done');
    const after = (await detail(id, mgr)).realized!;
    // Each figure is rounded to cents on the way out, so the difference of
    // two of them can sit a cent off the exact value.
    expect(after.cost - before.cost).toBeCloseTo(eff(78.5), 1);

    // Selling the rest of A allocates exactly the PO's fees, no more.
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[0], 3, 130), 'Done');
    const all = (await detail(id, mgr)).realized!;
    expect(all.soldQty).toBe(6);
    expect(all.cost).toBeCloseTo(GOODS + FEES, 2);
  });

  it('pays no commission on a PO projected below cost', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr, [
      { qty: 4, unitCost: 78.5, sellPrice: 50 },
      { qty: 2, unitCost: 40, sellPrice: 30 },
    ]);
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[1], 2, 55), 'Done');

    const r = (await detail(id, mgr)).realized!;
    expect(r.commission).toBe(0);
    expect(r.profit).toBeCloseTo(r.grossProfit, 2);
  });

  it('nets the commission on priced lines only: an unpriced line keeps its cost but earns nothing', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr, [
      { qty: 4, unitCost: 78.5, sellPrice: 120 },
      { qty: 2, unitCost: 40, sellPrice: null },
    ]);
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[1], 2, 55), 'Done');

    const r = (await detail(id, mgr)).realized!;
    // What B sold for and cost is real money and counts in full...
    expect(r.revenue).toBeCloseTo(110, 2);
    expect(r.cost).toBeCloseTo(2 * eff(40), 2);
    // ...but the commission is the purchaser's projection, which B never
    // entered: the dashboard and the spreadsheet drop an unpriced line
    // whole, cost included, and so must this.
    const commission = 4 * (120 - eff(78.5)) * RATE;
    expect(r.commission).toBeCloseTo(commission, 2);
    expect(r.profit).toBeCloseTo(r.grossProfit - commission, 2);
  });

  it('costs a sold unit its share of the negotiated lot price, and leaves the commission alone', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    // The lot was talked down to $300 for lines that list at $394.
    const LOT = 300;
    const { id, lineIds } = await createReviewing(pur, mgr, LINES, LOT);
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[1], 2, 55), 'Done');

    const r = (await detail(id, mgr)).realized!;
    // The price and the fee are both spread cost-weighted over the lines.
    expect(r.cost).toBeCloseTo(2 * 40 * (LOT + FEES) / GOODS, 2);
    expect(r.grossProfit).toBeCloseTo(110 - r.cost, 2);
    // The commission is line-level everywhere else too; a header price
    // never entered it.
    expect(r.commission).toBeCloseTo(COMMISSION, 2);
    expect((await listed(id, mgr)).realized).toEqual(r);
  });

  it('is null for the owning purchaser and for a manager previewing as purchaser', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    await moveSellOrder(mgr, await createSellOrderOn(mgr, lineIds[1], 2, 55), 'Done');

    expect((await detail(id, mgr)).realized).not.toBeNull();
    expect((await detail(id, pur)).realized).toBeNull();
    expect((await listed(id, pur)).realized).toBeNull();

    // Previewing as purchaser also narrows reads to the manager's own POs,
    // so the preview case needs a PO the manager owns.
    const own = await createReviewing(mgr, mgr);
    await moveSellOrder(mgr, await createSellOrderOn(mgr, own.lineIds[0], 1, 130), 'Done');
    expect((await detail(own.id, mgr)).realized).not.toBeNull();

    expect((await api('PATCH', '/api/me/preferences', {
      token: mgr, body: { 'tweaks.rolePreview': 'as_purchaser' },
    })).status).toBe(200);
    expect((await detail(own.id, mgr)).realized).toBeNull();
    expect((await listed(own.id, mgr)).realized).toBeNull();
  });
});
