import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// M5c regression: promote inserted sell_order_lines from accepted_qty recorded
// at decide-time, with NO re-check / lock of the underlying order_lines. If the
// inventory was consumed or became non-sellable between decide and promote,
// promote created an oversold/invalid sell order line. It must revalidate the
// inventory under lock, like validateSellLines does for normal sell orders.

async function setupAcceptedBid() {
  const { token: mgr } = await loginAs(ALEX);
  const cust = (await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'Vendor Co' } })).body.id;
  const link = (await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr })).body.token;
  const inv = await api<{ items: Array<{ id: string; qty: number }> }>(
    'GET', '/api/inventory?status=Done', { token: mgr });
  const line = inv.body.items.find(i => i.qty > 0)!;
  const bidId = (await api<{ bidId: string }>('POST', `/api/public/vendor/${link}/bids`, {
    body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
  })).body.bidId;
  const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
    'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
  const lineId = detail.body.bid.lines[0].id;
  const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
    token: mgr, body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 1, acceptedUnitPrice: 4 }] },
  });
  expect(dec.status).toBe(200);
  return { mgr, bidId, invId: line.id };
}

describe('POST /api/vendor-bids/:id/promote — revalidates inventory', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses to promote when the source inventory line is no longer sellable', async () => {
    const { mgr, bidId, invId } = await setupAcceptedBid();

    // Simulate the inventory being consumed/closed between decide and promote.
    await getTestDb()`UPDATE order_lines SET status = 'Sold' WHERE id = ${invId}`;

    const r = await api(`POST` as const, `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(r.status).not.toBe(201);

    const so = await getTestDb()`SELECT 1 FROM sell_orders WHERE notes = ${'From vendor bid ' + bidId}`;
    expect(so.length).toBe(0);
  });

  it('still promotes when the inventory is intact', async () => {
    const { mgr, bidId } = await setupAcceptedBid();
    const r = await api('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(r.status).toBe(201);
  });
});
