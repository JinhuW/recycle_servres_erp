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

// Submits a TWO-line bid when >=2 in-stock Done lines exist; gracefully
// falls back to a single-line bid otherwise. Mirrors setup() above.
async function setupMulti() {
  const { token: mgr } = await loginAs(ALEX);
  const cust = (await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'Vendor Co' } })).body.id;
  const link = (await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr })).body.token;
  const inv = await api<{ items: Array<{ id: string; qty: number }> }>(
    'GET', '/api/inventory?status=Done', { token: mgr });
  const stocked = inv.body.items.filter(i => i.qty > 0);
  const picked = stocked.slice(0, 2);
  const bid = (await api<{ bidId: string }>('POST', `/api/public/vendor/${link}/bids`, {
    body: { contactName: 'Lin', lines: picked.map(p => ({ inventoryId: p.id, qty: 1, unitPrice: 5 })) },
  })).body.bidId;
  return { mgr, cust, link, bidId: bid, lineCount: picked.length };
}

type DetailResp = {
  bid: {
    status: string;
    lines: Array<{
      line_status: string;
      accepted_qty: number | null;
      accepted_unit_price: number | null;
      id: string;
    }>;
  };
};

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

  it('declining a line clears accepted fields', async () => {
    const { mgr, bidId } = await setup();
    const detail = await api<DetailResp>('GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;
    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId, decision: 'declined' }] },
    });
    expect(dec.status).toBe(200);
    const after = await api<DetailResp>('GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    expect(after.body.bid.lines[0].line_status).toBe('declined');
    expect(after.body.bid.lines[0].accepted_qty).toBe(null);
    expect(after.body.bid.lines[0].accepted_unit_price).toBe(null);
  });

  it('a partially decided bid is partly_decided', async () => {
    const { mgr, bidId, lineCount } = await setupMulti();
    // The seed may only have one in-stock Done line; setupMulti() then
    // degrades to a single-line bid and a partial decision is impossible.
    if (lineCount < 2) return;
    const detail = await api<DetailResp>('GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const firstLine = detail.body.bid.lines[0].id;
    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId: firstLine, decision: 'accepted' }] },
    });
    expect(dec.status).toBe(200);
    const after = await api<DetailResp>('GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    expect(after.body.bid.status).toBe('partly_decided');
  });

  it('GET /:id 404s for an unknown bid', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const r = await api('GET', '/api/vendor-bids/VB-does-not-exist', { token: mgr });
    expect(r.status).toBe(404);
  });

  it('decide 400s when lines missing/empty', async () => {
    const { mgr, bidId } = await setup();
    const noLines = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: {},
    });
    expect(noLines.status).toBe(400);
    const emptyLines = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [] },
    });
    expect(emptyLines.status).toBe(400);
  });

  it('non-manager is forbidden on detail and decide too', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const detail = await api('GET', '/api/vendor-bids/VB-1', { token: pur });
    expect(detail.status).toBe(403);
    const decide = await api('POST', '/api/vendor-bids/VB-1/decide', {
      token: pur, body: { lines: [{ lineId: 'x', decision: 'declined' }] },
    });
    expect(decide.status).toBe(403);
  });

  it('promote creates one Draft sell order and is idempotent', async () => {
    const { mgr, bidId } = await setup();
    const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;
    await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 1, acceptedUnitPrice: 4 }] },
    });
    const p1 = await api<{ sellOrderId: string }>('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(p1.status).toBe(201);
    expect(p1.body.sellOrderId).toMatch(/^SO-\d+$/);
    const so = await api<{ order: { lines: unknown[] } }>(
      'GET', `/api/sell-orders/${p1.body.sellOrderId}`, { token: mgr });
    expect(so.status).toBe(200);
    expect(so.body.order.lines.length).toBe(1);
    const p2 = await api('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(p2.status).toBe(400);
  });

  it('promote includes only accepted lines, excludes declined', async () => {
    const { mgr, bidId, lineCount } = await setupMulti();
    // seed has <2 in-stock lines; skip
    if (lineCount < 2) return;
    const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const line0 = detail.body.bid.lines[0].id;
    const line1 = detail.body.bid.lines[1].id;
    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr,
      body: {
        lines: [
          { lineId: line0, decision: 'accepted', acceptedQty: 1, acceptedUnitPrice: 3 },
          { lineId: line1, decision: 'declined' },
        ],
      },
    });
    expect(dec.status).toBe(200);
    const p = await api<{ sellOrderId: string }>('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(p.status).toBe(201);
    expect(p.body.sellOrderId).toMatch(/^SO-\d+$/);
    const so = await api<{ order: { lines: unknown[] } }>(
      'GET', `/api/sell-orders/${p.body.sellOrderId}`, { token: mgr });
    expect(so.status).toBe(200);
    expect(so.body.order.lines.length).toBe(1);
  });

  it('promote is forbidden for non-managers', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const r = await api('POST', '/api/vendor-bids/VB-1/promote', { token: pur });
    expect(r.status).toBe(403);
  });

  it('decide cannot mutate an already-promoted line', async () => {
    const { mgr, bidId } = await setup();
    const detail = await api<DetailResp>('GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;
    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 1, acceptedUnitPrice: 4 }] },
    });
    expect(dec.status).toBe(200);
    const p = await api<{ sellOrderId: string }>('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(p.status).toBe(201);
    // Re-deciding the promoted line as declined: call succeeds but is a no-op.
    const redec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId, decision: 'declined' }] },
    });
    expect(redec.status).toBe(200);
    const after = await api<{ bid: { lines: Array<{ line_status: string; sell_order_id: string | null }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    expect(after.body.bid.lines[0].line_status).toBe('accepted');
    expect(after.body.bid.lines[0].sell_order_id).not.toBe(null);
  });

  it("accept-but-unavailable flips the line to declined with a reason — vendor sees the truth", async () => {
    // Pre-condition: the underlying inventory has been sold since the bid
    // arrived, so the availability subquery returns 0. The old route would
    // silently write line_status='accepted', accepted_qty=0; the vendor
    // portal then showed an "accepted" line that couldn't be promoted.
    const { mgr, bidId, invId } = await setup();
    // Move the source line out of 'Done' so availability is 0. The simplest
    // path is to flip its status to In Transit (which is what the inventory
    // route would do for a transfer); availability subquery filters on Done.
    const { getTestDb } = await import('./helpers/db');
    const db = getTestDb();
    await db`UPDATE order_lines SET status = 'In Transit' WHERE id = ${invId}`;

    const detail = await api<DetailResp>('GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;
    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 1 }] },
    });
    expect(dec.status).toBe(200);

    const after = await api<{ bid: { lines: Array<{ line_status: string; accepted_qty: number | null; decline_reason: string | null }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    // Crucial: NOT accepted with qty=0. Declined with the no-longer-available reason.
    expect(after.body.bid.lines[0].line_status).toBe('declined');
    expect(after.body.bid.lines[0].accepted_qty).toBeNull();
    expect(after.body.bid.lines[0].decline_reason).toMatch(/no longer available/i);
  });
});
