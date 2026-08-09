import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// An order line with no sell price has not been sold at cost — it simply has
// not been priced. It used to fall back to unit_cost in the list and dashboard
// aggregates, which invented revenue equal to the cost, so a PO nobody had
// priced yet reported its entire cost as projected revenue.
//
// The spreadsheet (routes/orders.ts) and the edit screen always excluded such
// lines. These pin the list agreeing with them.

type ListRow = { id: string; revenue: number; profit: number; lineCount: number; unpricedLineCount: number };

const listRow = async (token: string, id: string): Promise<ListRow> => {
  const r = await api<{ orders: ListRow[] }>('GET', '/api/orders?mine=true', { token });
  const row = r.body.orders.find(o => o.id === id);
  expect(row, `order ${id} missing from the list`).toBeTruthy();
  return row!;
};

const line = (over: Record<string, unknown>) => ({
  category: 'RAM', brand: 'Samsung', partNumber: 'REV-' + Math.random().toString(36).slice(2, 8),
  condition: 'Pulled — Tested', ...over,
});

describe('unpriced lines in the orders list', () => {
  beforeEach(async () => { await resetDb(); });

  it('contributes no revenue', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { lines: [line({ qty: 2, unitCost: 50 }), line({ qty: 2, unitCost: 50, sellPrice: 80 })] },
    });
    const row = await listRow(token, r.body.id);
    expect(row.revenue).toBeCloseTo(80 * 2, 2);
    expect(row.profit).toBeCloseTo((80 - 50) * 2, 2);
  });

  it('reports zero revenue for a PO nobody has priced', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token, body: { lines: [line({ qty: 4, unitCost: 25 })] },
    });
    const row = await listRow(token, r.body.id);
    expect(row.revenue).toBe(0);
  });

  it('counts the unpriced lines so the UI can explain the figure', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        lines: [
          line({ qty: 1, unitCost: 10 }),
          line({ qty: 1, unitCost: 10 }),
          line({ qty: 1, unitCost: 10, sellPrice: 30 }),
        ],
      },
    });
    const row = await listRow(token, r.body.id);
    expect(row.lineCount).toBe(3);
    expect(row.unpricedLineCount).toBe(2);
  });

  // Two spellings of unpriced is one too many: this SQL asks `sell_price IS
  // NULL` while every client gates on `> 0`, so a line saved at 0 counted as
  // priced here and unpriced in the tape — the same PO reporting "2 of 3
  // priced" on one screen and 3 of 3 on the next.
  it('stores a sell price of 0 as NULL, so both sides agree it is unpriced', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        lines: [
          line({ qty: 1, unitCost: 10, sellPrice: 0 }),
          line({ qty: 1, unitCost: 10, sellPrice: 30 }),
        ],
      },
    });
    expect(await getTestDb()`
      SELECT 1 FROM order_lines WHERE order_id = ${r.body.id} AND sell_price = 0
    `).toHaveLength(0);

    const row = await listRow(token, r.body.id);
    expect(row.unpricedLineCount).toBe(1);
  });

  it('clears a stored sell price when an edit sets it back to 0', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token, body: { lines: [line({ qty: 1, unitCost: 10, sellPrice: 30 })] },
    });
    const detail = await api<{ order: { lines: { id: string }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token });

    const r = await api('PATCH', '/api/orders/' + created.body.id, {
      token, body: { lines: [{ id: detail.body.order.lines[0].id, sellPrice: 0 }] },
    });
    expect(r.status).toBe(200);
    expect(await listRow(token, created.body.id)).toMatchObject({ unpricedLineCount: 1, revenue: 0 });
  });

  it('also normalises a sell price of 0 on PATCH addLines', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token, body: { lines: [line({ qty: 1, unitCost: 10, sellPrice: 30 })] },
    });
    await api('PATCH', '/api/orders/' + created.body.id, {
      token, body: { addLines: [line({ qty: 1, unitCost: 10, sellPrice: 0 })] },
    });
    expect(await listRow(token, created.body.id)).toMatchObject({ lineCount: 2, unpricedLineCount: 1 });
  });

  it('still nets order-level fees out of profit', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { otherFees: 12, lines: [line({ qty: 2, unitCost: 50, sellPrice: 80 })] },
    });
    const row = await listRow(token, r.body.id);
    expect(row.profit).toBeCloseTo((80 - 50) * 2 - 12, 2);
  });
});
