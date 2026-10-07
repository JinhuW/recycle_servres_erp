import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { firstCustomerId } from './helpers/fixtures';

type SellableItem = {
  inventoryId: string;
  category: string;
  label: string;
  partNumber: string | null;
  warehouseId: string | null;
  availableQty: number;
  sellPrice: number | null;
  draftCount: number;
  sourceOrderId: string;
  type: string | null;
  rank: string | null;
  speed: string | null;
};

const getSellable = (token: string, qs = '') =>
  api<{ items: SellableItem[]; hasMore: boolean }>('GET', `/api/sell-orders/sellable${qs}`, { token });

// Extra Reviewing lines on the PO of an existing sellable line, so they pass
// every sellability rule without driving a PO through its stages.
async function addReviewingLines(token: string, n: number, partNumber: string): Promise<string[]> {
  const seedLine = await freeSellableLine(token);
  const sql = getTestDb();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO order_lines (order_id, category, qty, unit_cost, part_number, status, position)
    SELECT order_id, 'RAM', 1, 10, ${partNumber}, 'Reviewing', 0
    FROM order_lines, generate_series(1, ${n})
    WHERE id = ${seedLine.id}
    RETURNING id
  `;
  return rows.map(r => r.id);
}

describe('GET /api/sell-orders/sellable', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns sellable inventory for a manager', async () => {
    const { token } = await loginAs(ALEX);
    const r = await getSellable(token);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.items.length).toBeGreaterThan(0);
    const item = r.body.items[0];
    expect(item.inventoryId).toBeTruthy();
    expect(item.availableQty).toBeGreaterThan(0);
  });

  it('carries the lot\'s PO and structured spec', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const sql = getTestDb();
    const [lot] = await sql<{ order_id: string }[]>`
      UPDATE order_lines SET type = 'Desktop', rank = '1Rx8', speed = '2666'
       WHERE id = ${line.id}
      RETURNING order_id
    `;
    const r = await getSellable(token);
    const item = r.body.items.find(i => i.inventoryId === line.id);
    expect(item).toMatchObject({
      sourceOrderId: lot.order_id, type: 'Desktop', rank: '1Rx8', speed: '2666',
    });
  });

  it('keeps a line on a rival draft listed, then drops it once fully committed', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);

    // The free line is sellable before it is committed.
    const before = await getSellable(token);
    expect(before.body.items.some(i => i.inventoryId === line.id)).toBe(true);

    const customerId = await firstCustomerId(token);
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        // The whole lot — a partial claim would leave the remainder listed.
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample',
          partNumber: 'PN-1', qty: line.qty, unitPrice: line.sell_price,
          warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(created.status).toBe(201);

    // A Draft is a proposal — the line stays offered, flagged as contended.
    const onDraft = await getSellable(token);
    const still = onDraft.body.items.find(i => i.inventoryId === line.id);
    expect(still).toBeDefined();
    expect(still!.draftCount).toBe(1);

    // Promoting the order commits the line, which drops it from the set.
    await api('POST', `/api/sell-orders/${created.body.id}/status`, {
      token, body: { to: 'Shipped', note: 's' },
    });
    const after = await getSellable(token);
    expect(after.body.items.some(i => i.inventoryId === line.id)).toBe(false);
  });

  it('does not count a draft that holds the line only at 0 as a rival', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId: await firstCustomerId(token),
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'Sample', partNumber: 'PN-1', qty: 1, unitPrice: 1 }],
      },
    });
    expect(created.status).toBe(201);
    await getTestDb()`UPDATE sell_order_lines SET qty = 0 WHERE sell_order_id = ${created.body.id}`;

    const r = await getSellable(token);
    expect(r.body.items.find(i => i.inventoryId === line.id)?.draftCount).toBe(0);
  });

  it('honours the q filter', async () => {
    const { token } = await loginAs(ALEX);
    const all = await getSellable(token);
    const withPn = all.body.items.find(i => i.partNumber);
    expect(withPn).toBeTruthy();
    const needle = withPn!.partNumber!.slice(0, 4);

    const filtered = await getSellable(token, `?q=${encodeURIComponent(needle)}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.length).toBeGreaterThan(0);
    expect(filtered.body.items.some(i => i.inventoryId === withPn!.inventoryId)).toBe(true);
  });

  it('caps the list at 200 and says so with hasMore', async () => {
    const { token } = await loginAs(ALEX);
    const before = await getSellable(token);
    expect(before.status).toBe(200);
    if (before.body.items.length < 200) expect(before.body.hasMore).toBe(false);

    await addReviewingLines(token, 210, 'HASMORE-PN');
    const r = await getSellable(token);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(200);
    expect(r.body.hasMore).toBe(true);
  });

  it('treats % in the search box as a literal character', async () => {
    const { token } = await loginAs(ALEX);
    const [id] = await addReviewingLines(token, 1, 'ESC%LIKE');
    const r = await getSellable(token, `?q=${encodeURIComponent('%')}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map(i => i.inventoryId)).toEqual([id]);
  });

  it('is manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await getSellable(token);
    expect(r.status).toBe(403);
  });
});
