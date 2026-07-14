import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  if (r.status !== 200 || !r.body.items?.length) throw new Error('no customers in seed');
  return r.body.items[0].id;
}

async function createDraftSellOrder(token: string, notes?: string): Promise<{ id: string; lineId: string }> {
  const line = await freeSellableLine(token);
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId,
      notes,
      lines: [{
        inventoryId: line.id, category: 'RAM', label: 'Sample',
        partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
        warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
  expect(r.status).toBe(201);
  return { id: r.body.id, lineId: line.id };
}

async function advanceTo(token: string, soId: string, to: string, note = 'note') {
  const r = await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to, note } });
  expect(r.status).toBe(200);
}

describe('POST /api/sell-orders/:id/status — Close', () => {
  beforeEach(async () => { await resetDb(); });

  it('Draft → Closed: succeeds and writes a closed event', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token,
      body: { to: 'Closed', closeReasonId: 'customer_cancelled', note: 'changed mind' },
    });
    expect(r.status).toBe(200);

    const sql = getTestDb();
    const order = (await sql`SELECT status, close_reason_id FROM sell_orders WHERE id = ${id}`)[0];
    expect(order.status).toBe('Closed');
    expect(order.close_reason_id).toBe('customer_cancelled');

    const ev = (await sql`
      SELECT kind, detail FROM sell_order_events
      WHERE sell_order_id = ${id} AND kind = 'closed'
    `)[0];
    expect(ev).toBeDefined();
    expect(ev.detail.reasonId).toBe('customer_cancelled');
    expect(ev.detail.note).toBe('changed mind');
    expect(ev.detail.fromStatus).toBe('Draft');

    // Spec: the per-status evidence panel must render for Closed.
    const meta = (await sql`
      SELECT note FROM sell_order_status_meta
      WHERE sell_order_id = ${id} AND status = 'Closed'
    `)[0];
    expect(meta).toBeDefined();
    expect(meta.note).toBe('changed mind');
  });

  it('Shipped → Closed releases the soft-committed inventory line', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await createDraftSellOrder(token);
    await advanceTo(token, id, 'Shipped', 'ship');

    // Before close: a second SO referencing the same line should be rejected.
    const customerId = await firstCustomerId(token);
    const blocked = await api('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 1 }],
      },
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);

    // Close.
    const close = await api('POST', `/api/sell-orders/${id}/status`, {
      token,
      body: { to: 'Closed', closeReasonId: 'lost_deal', note: 'lost' },
    });
    expect(close.status).toBe(200);

    // After close: the same line should now be accepted.
    const ok = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 1 }],
      },
    });
    expect(ok.status).toBe(201);
  });

  it('Awaiting payment → Closed: succeeds', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await advanceTo(token, id, 'Shipped', 'ship');
    await advanceTo(token, id, 'Awaiting payment', 'await');
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'returned', note: 'returned by customer' },
    });
    expect(r.status).toBe(200);
  });

  it('Done → Closed: 409 illegal transition', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await advanceTo(token, id, 'Shipped', 'ship');
    await advanceTo(token, id, 'Awaiting payment', 'await');
    await advanceTo(token, id, 'Done', 'paid');
    const r = await api<{ error: string }>('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'late' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/illegal transition/);
  });

  it('Close without closeReasonId: 400', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', note: 'no reason' },
    });
    expect(r.status).toBe(400);
  });

  it('Close with unknown closeReasonId: 400', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'made_up', note: 'note' },
    });
    expect(r.status).toBe(400);
  });

  it('Close without note: 200 (note is optional, only the reason is required)', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other' },
    });
    expect(r.status).toBe(200);
  });

  it('Closed → Shipped: 409 illegal transition', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'n' },
    });
    const r = await api<{ error: string }>('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 'try' },
    });
    expect(r.status).toBe(409);
  });

  it('Closed → Draft (reopen): clears reason, writes reopened event, can re-advance', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });
    const reopen = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Draft', note: 'customer came back' },
    });
    expect(reopen.status).toBe(200);

    const sql = getTestDb();
    const order = (await sql`SELECT status, close_reason_id FROM sell_orders WHERE id = ${id}`)[0];
    expect(order.status).toBe('Draft');
    expect(order.close_reason_id).toBeNull();

    const ev = (await sql`
      SELECT kind, detail FROM sell_order_events
      WHERE sell_order_id = ${id} AND kind = 'reopened'
    `)[0];
    expect(ev).toBeDefined();
    expect(ev.detail.note).toBe('customer came back');
    expect(ev.detail.fromStatus).toBe('Closed');

    // Can re-advance like any Draft.
    await advanceTo(token, id, 'Shipped', 're-shipped');
  });

  it('Reopen appends the reason to existing order notes', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token, 'original');
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });
    const reopen = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Draft', note: 'customer came back' },
    });
    expect(reopen.status).toBe(200);

    const sql = getTestDb();
    const order = (await sql`SELECT notes FROM sell_orders WHERE id = ${id}`)[0];
    expect(order.notes).toBe('original\n\nReopened: customer came back');
  });

  it('Reopen with empty prior notes stores just the reason line', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });
    const reopen = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Draft', note: '  deal is back on  ' },
    });
    expect(reopen.status).toBe(200);

    const sql = getTestDb();
    const order = (await sql`SELECT notes FROM sell_orders WHERE id = ${id}`)[0];
    expect(order.notes).toBe('Reopened: deal is back on');
  });

  it('Reopen by a non-creator manager: 403, order stays Closed', async () => {
    const { token: alexToken } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(alexToken, 'original');
    await api('POST', `/api/sell-orders/${id}/status`, {
      token: alexToken, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });

    const { token: sofiaToken } = await loginAs(SOFIA);
    const r = await api<{ error: string }>('POST', `/api/sell-orders/${id}/status`, {
      token: sofiaToken, body: { to: 'Draft', note: 'let me reopen it' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/creator/);

    const sql = getTestDb();
    const order = (await sql`SELECT status, notes FROM sell_orders WHERE id = ${id}`)[0];
    expect(order.status).toBe('Closed');
    expect(order.notes).toBe('original');
  });

  it('Reopen of a creator-less order (MCP-created): any manager may reopen', async () => {
    const { token: alexToken } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(alexToken);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token: alexToken, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });

    const sql = getTestDb();
    await sql`UPDATE sell_orders SET created_by = NULL WHERE id = ${id}`;

    const { token: sofiaToken } = await loginAs(SOFIA);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token: sofiaToken, body: { to: 'Draft', note: 'orphan reopen' },
    });
    expect(r.status).toBe(200);
  });

  it('Reopen without note: 400', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Draft' },
    });
    expect(r.status).toBe(400);
  });

  it('Non-manager Close: 403', async () => {
    const { token: managerToken } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(managerToken);
    const { token: purchaserToken } = await loginAs(MARCUS);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token: purchaserToken,
      body: { to: 'Closed', closeReasonId: 'other', note: 'n' },
    });
    expect(r.status).toBe(403);
  });
});
