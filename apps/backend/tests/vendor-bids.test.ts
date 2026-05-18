import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

async function setup() {
  const { token: mgr } = await loginAs(ALEX);
  const cust = (await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'Vendor Co' } })).body.id;
  const link = (await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr })).body.token;
  const inv = await api<{ items: Array<{ id: string; qty: number }> }>(
    'GET', '/api/inventory?status=Done', { token: mgr });
  const line = inv.body.items.find(i => i.qty > 0)!;
  const bid = (await api<{ bidId: string }>('POST', `/api/public/vendor/${link}/bids`, {
    body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
  })).body.bidId;
  return { mgr, cust, link, bidId: bid, invId: line.id, invQty: line.qty };
}

describe('vendor-bids manager route', () => {
  beforeAll(async () => { await resetDb(); });

  it('non-manager is forbidden', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const r = await api('GET', '/api/vendor-bids', { token: pur });
    expect(r.status).toBe(403);
  });

  it('inbox lists the submitted bid', async () => {
    const { mgr } = await setup();
    const r = await api<{ items: Array<{ id: string; line_count: number }> }>(
      'GET', '/api/vendor-bids', { token: mgr });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
  });

  it('decide accepts a line, clamps to availability, transitions status', async () => {
    const { mgr, bidId } = await setup();
    const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;
    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 999999, acceptedUnitPrice: 4 }] },
    });
    expect(dec.status).toBe(200);
    const after = await api<{ bid: { status: string; lines: Array<{ accepted_qty: number; available: number }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    expect(after.body.bid.status).toBe('decided');
    expect(after.body.bid.lines[0].accepted_qty).toBeLessThanOrEqual(after.body.bid.lines[0].available);
  });
});
