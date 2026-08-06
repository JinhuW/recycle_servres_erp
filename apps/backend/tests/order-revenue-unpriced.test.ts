import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
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
