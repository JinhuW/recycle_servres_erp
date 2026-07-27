import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

type SellableItem = {
  inventoryId: string;
  category: string;
  label: string;
  partNumber: string | null;
  warehouseId: string | null;
  availableQty: number;
  sellPrice: number | null;
  draftCount: number;
};

const getSellable = (token: string, qs = '') =>
  api<{ items: SellableItem[] }>('GET', `/api/sell-orders/sellable${qs}`, { token });

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
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

  it('keeps a line on a rival draft listed, then drops it once committed', async () => {
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
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample',
          partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
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

  it('is manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await getSellable(token);
    expect(r.status).toBe(403);
  });
});
