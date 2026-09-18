import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS, PRIYA, ALEX } from './helpers/auth';

// The contribution tables regroup the dashboard's own figures: cost is the PO
// header total over every PO past Draft, sales and profit are the revenue and
// gross-profit tiles' rows. So a card's total must equal the tile, and every
// dimension tab of a card must sum to the same total.

type Row = { id: string | null; name: string | null; amount: number; count: number };
type Rows = { rows: Row[]; others: { n: number; amount: number } | null };
type Metric = { total: number; count: number; byDim: Partial<Record<'supplier' | 'purchaser' | 'customer' | 'category', Rows>> };
type Body = {
  kpis: { count: number; revenue: number; profit: number };
  series: { cost: number }[];
  contrib: { cost: Metric; revenue: Metric; profit: Metric };
};

const sum = (r: Rows) => r.rows.reduce((s, x) => s + x.amount, 0) + (r.others?.amount ?? 0);
const byName = (r: Rows, name: string | null) => r.rows.find(x => x.name === name)!;

async function userId(email: string): Promise<string> {
  return (await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`)[0].id;
}

async function clearWindow() {
  const db = getTestDb();
  await db`DELETE FROM sell_order_lines`;
  await db`DELETE FROM sell_orders`;
  await db`UPDATE orders SET created_at = NOW() - INTERVAL '900 days'`;
}

async function supplier(name: string): Promise<string> {
  return (await getTestDb()<{ id: string }[]>`INSERT INTO suppliers (name) VALUES (${name}) RETURNING id`)[0].id;
}

async function customer(name: string): Promise<string> {
  return (await getTestDb()<{ id: string }[]>`INSERT INTO customers (name) VALUES (${name}) RETURNING id`)[0].id;
}

async function insertPO(
  id: string, ownerEmail: string,
  opts: { supplierId: string | null; category: string; totalCost?: number; otherFees?: number; lifecycle?: string },
  lines: { category: string; unitCost: number; sellPrice: number; qty: number }[],
): Promise<string[]> {
  const db = getTestDb();
  const owner = await userId(ownerEmail);
  await db`
    INSERT INTO orders (id, user_id, supplier_id, category, lifecycle, commission_rate, other_fees, total_cost, created_at)
    VALUES (${id}, ${owner}, ${opts.supplierId}, ${opts.category}, ${opts.lifecycle ?? 'done'}, 0.1,
            ${opts.otherFees ?? 0}, ${opts.totalCost ?? null}, NOW())
  `;
  const ids: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const r = await db<{ id: string }[]>`
      INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, position)
      VALUES (${id}, ${l.category}, ${l.qty}, ${l.unitCost}, ${l.sellPrice}, ${i}) RETURNING id
    `;
    ids.push(r[0].id);
  }
  return ids;
}

async function insertDoneSale(id: string, customerId: string, lines: { inventoryId: string | null; category: string; unitPrice: number }[]) {
  const db = getTestDb();
  await db`
    INSERT INTO sell_orders (id, customer_id, status, created_by, created_at, updated_at)
    VALUES (${id}, ${customerId}, 'Done', (SELECT id FROM users WHERE email = ${ALEX}), NOW(), NOW())
  `;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db`
      INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price, position)
      VALUES (${id}, ${l.inventoryId}, ${l.category}, 'x', 1, ${l.unitPrice}, ${i})
    `;
  }
}

// Alpha: one RAM PO with a negotiated header of 950 (lines say 100), and one
//        HDD PO still in review, 200 — spend, but not yet a projection.
// Beta:  one mixed PO, header NULL → line goods 300, and a Draft PO of 999
//        that counts for nothing.
// Nobody: one HDD PO with no supplier, 50.
// Sales: Cust A bought Alpha's RAM line at 150 (profit 50); Cust B bought
// Beta's HDD line at 260 (profit 60) plus a line with no inventory link at
// 999, which the revenue tile has never counted.
async function fixture() {
  await clearWindow();
  const alpha = await supplier('Alpha Corp');
  const beta  = await supplier('Beta Ltd');
  const [ramLine] = await insertPO('PO-CT-1', MARCUS, { supplierId: alpha, category: 'RAM', totalCost: 950 },
    [{ category: 'RAM', unitCost: 100, sellPrice: 150, qty: 1 }]);
  const [, hddLine] = await insertPO('PO-CT-2', PRIYA, { supplierId: beta, category: 'Mixed' }, [
    { category: 'RAM', unitCost: 100, sellPrice: 150, qty: 1 },
    { category: 'HDD', unitCost: 200, sellPrice: 260, qty: 1 },
  ]);
  await insertPO('PO-CT-3', MARCUS, { supplierId: null, category: 'HDD' },
    [{ category: 'HDD', unitCost: 50, sellPrice: 80, qty: 1 }]);
  await insertPO('PO-CT-4', MARCUS, { supplierId: alpha, category: 'HDD', lifecycle: 'reviewing' },
    [{ category: 'HDD', unitCost: 200, sellPrice: 260, qty: 1 }]);
  await insertPO('PO-CT-5', MARCUS, { supplierId: beta, category: 'RAM', lifecycle: 'draft' },
    [{ category: 'RAM', unitCost: 999, sellPrice: 1200, qty: 1 }]);
  const custA = await customer('Cust A');
  const custB = await customer('Cust B');
  await insertDoneSale('SO-CT-A', custA, [{ inventoryId: ramLine, category: 'RAM', unitPrice: 150 }]);
  await insertDoneSale('SO-CT-B', custB, [
    { inventoryId: hddLine, category: 'HDD', unitPrice: 260 },
    { inventoryId: null,    category: 'SSD', unitPrice: 999 },
  ]);
}

describe('GET /api/dashboard — contributions', () => {
  beforeEach(async () => { await resetDb(); });

  it('cost counts every PO past Draft, at header grain, with a Mixed row and a no-supplier row', async () => {
    await fixture();
    const { token } = await loginAs(ALEX);
    const r = await api<Body>('GET', '/api/dashboard?range=7d', { token });
    expect(r.status).toBe(200);
    const cost = r.body.contrib.cost;
    // 950 + 300 + 50 + the Reviewing 200; the Draft 999 is not spend.
    expect(cost.total).toBeCloseTo(1500, 2);
    expect(cost.count).toBe(4);
    const { supplier: s, purchaser: p, category: c } = cost.byDim;
    for (const dim of [s!, p!, c!]) expect(sum(dim)).toBeCloseTo(1500, 2);
    expect(byName(s!, 'Alpha Corp')).toMatchObject({ amount: 1150, count: 2 });
    expect(byName(s!, 'Beta Ltd')).toMatchObject({ amount: 300, count: 1 });
    expect(byName(s!, null)).toMatchObject({ id: null, amount: 50, count: 1 });
    expect(s!.rows[0].name).toBe('Alpha Corp');
    expect(p!.rows.find(x => x.count === 3)).toMatchObject({ amount: 1200, count: 3 });
    expect(byName(c!, 'RAM').amount).toBeCloseTo(950, 2);
    expect(byName(c!, 'Mixed').amount).toBeCloseTo(300, 2);
    expect(byName(c!, 'HDD').amount).toBeCloseTo(250, 2);
    // The chart's down-bars are the same figure.
    expect(r.body.series.reduce((acc, b) => acc + b.cost, 0)).toBeCloseTo(1500, 2);
  });

  it('sales and profit cards equal the tiles; a line with no inventory link is in neither', async () => {
    await fixture();
    const { token } = await loginAs(ALEX);
    const r = await api<Body>('GET', '/api/dashboard?range=7d', { token });
    const { revenue, profit } = r.body.contrib;
    expect(r.body.kpis.revenue).toBeCloseTo(410, 2);
    expect(revenue.total).toBeCloseTo(r.body.kpis.revenue, 2);
    expect(profit.total).toBeCloseTo(r.body.kpis.profit, 2);
    expect(profit.total).toBeCloseTo(110, 2);
    expect(revenue.count).toBe(r.body.kpis.count);
    for (const dim of Object.values(revenue.byDim)) expect(sum(dim)).toBeCloseTo(410, 2);
    for (const dim of Object.values(profit.byDim)) expect(sum(dim)).toBeCloseTo(110, 2);
    expect(byName(revenue.byDim.customer!, 'Cust A').amount).toBeCloseTo(150, 2);
    expect(byName(revenue.byDim.customer!, 'Cust B').amount).toBeCloseTo(260, 2);
    expect(byName(profit.byDim.customer!, 'Cust B').amount).toBeCloseTo(60, 2);
    expect(byName(revenue.byDim.category!, 'HDD').amount).toBeCloseTo(260, 2);
    expect(revenue.byDim.category!.rows.some(x => x.name === 'SSD')).toBe(false);
    expect(Object.keys(revenue.byDim).sort()).toEqual(['category', 'customer', 'purchaser']);
  });

  it('keeps the top seven rows and folds the rest into "others"', async () => {
    await clearWindow();
    for (let i = 1; i <= 9; i++) {
      const sid = await supplier(`S${i}`);
      await insertPO(`PO-CT-N${i}`, MARCUS, { supplierId: sid, category: 'RAM' },
        [{ category: 'RAM', unitCost: i * 10, sellPrice: i * 20, qty: 1 }]);
    }
    const { token } = await loginAs(ALEX);
    const r = await api<Body>('GET', '/api/dashboard?range=7d', { token });
    const s = r.body.contrib.cost.byDim.supplier!;
    expect(s.rows).toHaveLength(7);
    expect(s.rows.map(x => x.name)).toEqual(['S9', 'S8', 'S7', 'S6', 'S5', 'S4', 'S3']);
    expect(s.others).toEqual({ n: 2, amount: 30 });
    expect(sum(s)).toBeCloseTo(r.body.contrib.cost.total, 2);
  });

  it('a purchaser gets supplier and category only, over their own POs, with no customer in sight', async () => {
    await fixture();
    const { token } = await loginAs(MARCUS);
    const r = await api<Body>('GET', '/api/dashboard?range=7d', { token });
    const { cost, revenue, profit } = r.body.contrib;
    for (const m of [cost, revenue, profit]) {
      expect(Object.keys(m.byDim).sort()).toEqual(['category', 'supplier']);
    }
    // PO-CT-1 (950), PO-CT-3 (50) and the Reviewing PO-CT-4 (200) are
    // Marcus's spend; his Draft PO-CT-5 is not, and Priya's 300 is not his.
    expect(cost.total).toBeCloseTo(1200, 2);
    expect(cost.count).toBe(3);
    expect(byName(cost.byDim.supplier!, 'Beta Ltd')).toBeUndefined();
    // Projected, from the reviewed lines only: revenue 150 + 80, profit
    // 50 + 30 — the Reviewing PO's margin is not yet a projection.
    expect(revenue.total).toBeCloseTo(230, 2);
    expect(revenue.count).toBe(2);
    expect(profit.total).toBeCloseTo(80, 2);
    expect(JSON.stringify(r.body)).not.toContain('Cust ');
  });
});
