import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// A committed sell order reserves the QUANTITY it names, not the whole lot.
// Selling 20 of a 100-piece line has to leave 80 on the shelf for the next
// order — the previous rule blocked the lot outright the moment any order
// left Draft.

type SellableItem = { inventoryId: string; availableQty: number };

const getSellable = (token: string) =>
  api<{ items: SellableItem[] }>('GET', '/api/sell-orders/sellable', { token });

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

async function draftFor(token: string, inventoryId: string, qty: number, price: number) {
  const customerId = await firstCustomerId(token);
  return api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId,
      lines: [{
        inventoryId, category: 'RAM', label: 'Sample', partNumber: 'PN-1',
        qty, unitPrice: price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
}

const ship = (token: string, id: string) =>
  api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 's' } });

describe('partially committed inventory stays sellable', () => {
  beforeEach(async () => { await resetDb(); });

  it('keeps the unsold remainder listed and lets a second order take it', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3);

    const first = await draftFor(token, line.id, 1, line.sell_price);
    expect(first.status).toBe(201);
    expect((await ship(token, first.body.id)).status).toBe(200);

    // Still offered, with the committed unit netted out of availableQty.
    const listed = (await getSellable(token)).body.items
      .find(i => i.inventoryId === line.id);
    expect(listed).toBeDefined();
    expect(listed!.availableQty).toBe(line.qty - 1);

    // The remainder can be sold on a second order.
    const second = await draftFor(token, line.id, line.qty - 1, line.sell_price);
    expect(second.status).toBe(201);
    expect((await ship(token, second.body.id)).status).toBe(200);

    // Now fully spoken for — it drops out of the picker.
    const after = (await getSellable(token)).body.items
      .find(i => i.inventoryId === line.id);
    expect(after).toBeUndefined();
  });

  it('caps a draft line at the remainder, not at the whole lot', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3);

    const first = await draftFor(token, line.id, 1, line.sell_price);
    expect((await ship(token, first.body.id)).status).toBe(200);
    const second = await draftFor(token, line.id, 1, line.sell_price);

    type Detail = { order: { lines: { maxQty: number }[] } };
    const shown = await api<Detail>('GET', `/api/sell-orders/${second.body.id}`, { token });
    expect(shown.body.order.lines[0].maxQty).toBe(line.qty - 1);

    // The order's own claim doesn't shrink its own ceiling.
    const own = await api<Detail>('GET', `/api/sell-orders/${first.body.id}`, { token });
    expect(own.body.order.lines[0].maxQty).toBe(line.qty);
  });

  it('rejects a second order that overruns the remainder', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);

    const first = await draftFor(token, line.id, 1, line.sell_price);
    expect((await ship(token, first.body.id)).status).toBe(200);

    const over = await draftFor(token, line.id, line.qty, line.sell_price);
    expect(over.status).toBe(400);
    expect(String(over.body ? JSON.stringify(over.body) : '')).toMatch(/committed|available/i);
  });
});
