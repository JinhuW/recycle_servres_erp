/**
 * Wave 2B backend fix tests.
 * Fix 1: sell_price can be explicitly cleared to null in PATCH
 * Fix 2: Human-IDs (SO-/PO-) allocated inside their transaction
 * Fix 3: Backward-advance guard on committed inventory
 *
 * Single top-level describe with ONE beforeAll(resetDb) to avoid concurrent
 * resetDb races (the known flake pattern in this test suite).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { signOffAll } from './helpers/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  if (r.status !== 200 || !r.body.items?.length) throw new Error('no customers in seed');
  return r.body.items[0].id;
}

/** Create a purchase order with one RAM line and advance it to `reviewing`. */
async function makeReviewingOrder(managerToken: string, purchaserToken: string): Promise<{ orderId: string; lineId: string }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: purchaserToken,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001',
      category: 'RAM', warehouseId: 'WH-LA1',
      lines: [{ category: 'RAM', qty: 2, unitCost: 50, condition: 'New', sellPrice: 80 }],
    },
  });
  expect(created.status).toBe(201);
  const orderId = created.body.id;

  // Draft → in_transit
  await api('POST', `/api/orders/${orderId}/advance`, { token: purchaserToken });
  // in_transit → reviewing
  await api('POST', `/api/orders/${orderId}/advance`, { token: managerToken, body: { toStage: 'reviewing' } });

  const detail = await api<{ order: { lines: { id: string }[] } }>(
    'GET', `/api/orders/${orderId}`, { token: managerToken });
  return { orderId, lineId: detail.body.order.lines[0].id };
}

/** Create a purchase order with one RAM line and advance it to `done`. */
async function makeDoneOrder(managerToken: string, purchaserToken: string): Promise<{ orderId: string; lineId: string }> {
  const { orderId, lineId } = await makeReviewingOrder(managerToken, purchaserToken);
  await api('POST', `/api/orders/${orderId}/advance`, { token: managerToken, body: { toStage: 'done' } });
  return { orderId, lineId };
}

// ─── All Wave 2B tests in one block (single resetDb avoids flake) ─────────────

describe('Wave 2B backend fixes', () => {
  beforeAll(async () => { await resetDb(); });

  // ─── Fix 1: sell_price cleared to null via PATCH ─────────────────────────

  it('Fix 1a — PATCH sellPrice: null clears sell_price to NULL', async () => {
    const { token: pur } = await loginAs(MARCUS);

    // Create a line with a sell price
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pur,
      body: {
        paypalTxnId: 'TESTPAYTXN0000001',
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 50, condition: 'New', sellPrice: 99.99 }],
      },
    });
    expect(created.status).toBe(201);
    const orderId = created.body.id;

    const before = await api<{ order: { lines: { id: string; sellPrice: number | null }[] } }>(
      'GET', `/api/orders/${orderId}`, { token: pur });
    expect(before.body.order.lines[0].sellPrice).toBe(99.99);
    const lineId = before.body.order.lines[0].id;

    // PATCH with explicit null — should clear the column
    const patch = await api('PATCH', `/api/orders/${orderId}`, {
      token: pur,
      body: { lines: [{ id: lineId, sellPrice: null }] },
    });
    expect(patch.status).toBe(200);

    const after = await api<{ order: { lines: { sellPrice: number | null }[] } }>(
      'GET', `/api/orders/${orderId}`, { token: pur });
    expect(after.body.order.lines[0].sellPrice).toBeNull();
  });

  it('Fix 1b — omitting sellPrice from patch body does NOT clear the column', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pur,
      body: {
        paypalTxnId: 'TESTPAYTXN0000001',
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 50, condition: 'New', sellPrice: 77 }],
      },
    });
    const orderId = created.body.id;
    const detail = await api<{ order: { lines: { id: string; sellPrice: number | null }[] } }>(
      'GET', `/api/orders/${orderId}`, { token: pur });
    const lineId = detail.body.order.lines[0].id;

    // Patch with no sellPrice field — value should be preserved
    await api('PATCH', `/api/orders/${orderId}`, {
      token: pur,
      body: { lines: [{ id: lineId, qty: 2 }] },
    });

    const after = await api<{ order: { lines: { sellPrice: number | null }[] } }>(
      'GET', `/api/orders/${orderId}`, { token: pur });
    expect(after.body.order.lines[0].sellPrice).toBe(77);
  });

  // ─── Fix 2: Human-IDs inside transactions ────────────────────────────────

  it('Fix 2 — SO counter: failed sell-order create does not consume an id', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const customerId = await firstCustomerId(mgr);

    // Fail inside the tx — inventory not found → rollback
    const bad = await api('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId,
        lines: [{
          inventoryId: '00000000-0000-0000-0000-000000000001',
          category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 10,
        }],
      },
    });
    expect(bad.status).toBe(400);

    // Get the next sequential id from a successful create
    const line = await freeSellableLine(mgr);
    const good = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId,
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: line.sell_price,
        }],
      },
    });
    expect(good.status).toBe(201);
    const id1 = good.body.id;

    // Second successful create should be id1+1, not id1+2 or higher
    const line2 = await freeSellableLine(mgr);
    const good2 = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId,
        lines: [{
          inventoryId: line2.id, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: line2.sell_price,
        }],
      },
    });
    expect(good2.status).toBe(201);
    const id2 = good2.body.id;

    // IDs should be consecutive (no gap from the rolled-back failed create)
    const n1 = parseInt(id1.replace('SO-', ''), 10);
    const n2 = parseInt(id2.replace('SO-', ''), 10);
    expect(n2).toBe(n1 + 1);
  });

  // ─── Fix 3: Backward-advance guard on committed inventory ─────────────────

  it('Fix 3a — 409 with offendingLineIds and sellOrderIds when a back-advance past Reviewing would break committed sell orders', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: pur } = await loginAs(MARCUS);

    const { orderId, lineId } = await makeDoneOrder(mgr, pur);

    // Create a sell order referencing the Done line and commit it
    const customerId = await firstCustomerId(mgr);
    const soRes = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId,
        lines: [{
          inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 80,
        }],
      },
    });
    expect(soRes.status).toBe(201);
    expect((await api('POST', `/api/sell-orders/${soRes.body.id}/status`, {
      token: mgr, body: { to: 'Awaiting payment', note: 'a' },
    })).status).toBe(200);

    // done → reviewing leaves the committed line at Done; past it to In
    // Transit, the line would leave the sellable statuses — 409.
    const back = await api<{ lifecycle: string }>('POST', `/api/orders/${orderId}/advance`, {
      token: mgr, body: { toStage: 'reviewing' },
    });
    expect(back.status).toBe(200);
    expect(back.body.lifecycle).toBe('reviewing');
    const r = await api<{ error: string; offendingLineIds: string[]; sellOrderIds: string[] }>(
      'POST', `/api/orders/${orderId}/advance`, {
        token: mgr, body: { toStage: 'in_transit' },
      });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cancel those sell orders/i);
    expect(r.body.offendingLineIds).toContain(lineId);
    expect(r.body.sellOrderIds).toEqual([soRes.body.id]);
  });

  it('Fix 3a′ — a Draft sell order does not block done → reviewing (the line stays sellable)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: pur } = await loginAs(MARCUS);

    const { orderId, lineId } = await makeDoneOrder(mgr, pur);

    const customerId = await firstCustomerId(mgr);
    const soRes = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId,
        lines: [{
          inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 80,
        }],
      },
    });
    expect(soRes.status).toBe(201);

    const r = await api<{ lifecycle: string }>('POST', `/api/orders/${orderId}/advance`, {
      token: mgr, body: { toStage: 'reviewing' },
    });
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('reviewing');
  });

  it('Fix 3b — forward advance is not blocked even with lines on sell orders', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: pur } = await loginAs(MARCUS);
    const { orderId } = await makeReviewingOrder(mgr, pur);

    // reviewing → done should succeed — forward moves are always allowed
    const r = await api('POST', `/api/orders/${orderId}/advance`, {
      token: mgr, body: { toStage: 'done' },
    });
    expect(r.status).toBe(200);
  });

  it('Fix 3c — back-advance succeeds when sell order is Done (no open commitments)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: pur } = await loginAs(MARCUS);
    const { orderId, lineId } = await makeDoneOrder(mgr, pur);

    // Create a sell order and close it
    const customerId = await firstCustomerId(mgr);
    const soRes = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId,
        lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: 80 }],
      },
    });
    expect(soRes.status).toBe(201);
    const soId = soRes.body.id;

    for (const to of ['Shipped', 'Awaiting payment', 'Done']) {
      if (to === 'Done') await signOffAll(soId);
      await api('POST', `/api/sell-orders/${soId}/status`, { token: mgr, body: { to, note: 'evidence' } });
    }

    // Now back-advance the PO — sell order is Done, so no open commitments
    const r = await api('POST', `/api/orders/${orderId}/advance`, {
      token: mgr, body: { toStage: 'reviewing' },
    });
    expect(r.status).toBe(200);
  });
});
