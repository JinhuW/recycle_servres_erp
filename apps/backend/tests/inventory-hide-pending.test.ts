import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// `?hidePending=1` drops inventory lines already claimed by a non-terminal sell
// order (Draft / Shipped / Awaiting payment) so a new sell order can't re-pick
// committed stock. Done/Closed release the claim.
describe('GET /api/inventory — hidePending filter', () => {
  beforeEach(async () => { await resetDb(); });

  async function firstCustomerId(token: string): Promise<string> {
    const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
    return r.body.items[0].id;
  }

  async function draftSellOrderOn(token: string, line: { id: string; sell_price: number }): Promise<string> {
    const r = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId: await firstCustomerId(token),
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample',
          partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
          warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(r.status).toBe(201);
    return r.body.id;
  }

  it('hides a line committed to a Draft sell order; lists it otherwise', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    await draftSellOrderOn(token, line);

    const withPending = await api<{ items: { id: string }[] }>('GET', '/api/inventory?status=Reviewing', { token });
    expect(withPending.body.items.some(i => i.id === line.id)).toBe(true);

    const hidden = await api<{ items: { id: string }[] }>('GET', '/api/inventory?status=Reviewing&hidePending=1', { token });
    expect(hidden.status).toBe(200);
    expect(hidden.body.items.some(i => i.id === line.id)).toBe(false);
  });

  it('keeps a line whose only sell order is Done (claim released)', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const soId = await draftSellOrderOn(token, line);

    // Drive Draft → Done directly; we're exercising the list filter, not the
    // evidence-gated status flow.
    const sql = getTestDb();
    await sql`UPDATE sell_orders SET status = 'Done' WHERE id = ${soId}`;

    const hidden = await api<{ items: { id: string }[] }>('GET', '/api/inventory?status=Reviewing&hidePending=1', { token });
    expect(hidden.body.items.some(i => i.id === line.id)).toBe(true);
  });

  it('applies to the grouped products endpoint too', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    await draftSellOrderOn(token, line);

    const hidden = await api<{ products: { lines: { id: string }[] }[] }>(
      'GET', '/api/inventory/products?status=Reviewing&hidePending=1', { token });
    expect(hidden.status).toBe(200);
    const allLotIds = hidden.body.products.flatMap(p => p.lines.map(l => l.id));
    expect(allLotIds.includes(line.id)).toBe(false);
  });
});
