import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { eventsOf } from './helpers/sellOrderEvents';

const pdf = join(__dirname, 'fixtures', 'invoice.pdf');

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

describe('sell-order audit events', () => {
  beforeEach(async () => { await resetDb(); });

  it('POST /api/sell-orders emits one `created` event', async () => {
    const { token, user } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const r = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        notes: 'first order',
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample',
          partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
          warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(r.status).toBe(201);

    const events = await eventsOf(r.body.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('created');
    expect(events[0].actor_id).toBe(user.id);
    expect(events[0].detail).toMatchObject({
      source: 'manager',
      lineCount: 1,
      customerId,
    });
  });

  it('vendor-bid promotion emits `created` with source: vendor_bid', async () => {
    const { token } = await loginAs(ALEX);
    const sql = getTestDb();

    const bidRow = (await sql`
      SELECT vb.id AS bid_id
      FROM vendor_bids vb
      JOIN vendor_bid_lines vbl ON vbl.bid_id = vb.id
      WHERE vbl.line_status = 'accepted'
        AND vbl.sell_order_id IS NULL
        AND vbl.accepted_qty > 0
      LIMIT 1
    `)[0] as { bid_id: string } | undefined;
    if (!bidRow) throw new Error('seed has no promotable vendor bid; expand seed.mjs');

    const r = await api<{ sellOrderId: string }>(
      'POST', `/api/vendor-bids/${bidRow.bid_id}/promote`, { token });
    expect(r.status).toBe(201);

    const events = await eventsOf(r.body.sellOrderId);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('created');
    expect(events[0].detail).toMatchObject({
      source: 'vendor_bid',
      vendorBidId: bidRow.bid_id,
    });
  });

  it('PATCH that changes only `notes` emits one `meta_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId, notes: 'before',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token, body: { notes: 'after' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind !== 'created');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('meta_changed');
    expect(events[0].detail).toMatchObject({
      changes: [{ field: 'notes', from: 'before', to: 'after' }],
    });
  });

  it('PATCH with identical values emits zero events', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId, notes: 'same',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token, body: { notes: 'same' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind !== 'created');
    expect(events).toHaveLength(0);
  });

  it('PATCH editing an inventory-backed line qty emits `line_edited`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3); // need qty >= 3 so we can bump from 1 to 2
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: {
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 2, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind !== 'created');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('line_edited');
    expect(events[0].detail).toMatchObject({
      inventoryId: line.id,
      changes: [{ field: 'qty', from: 1, to: 2 }],
    });
  });

  it('status transition emits `status_changed` with from/to', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 'shipped via UPS' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_changed');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ from: 'Draft', to: 'Shipped' });
  });

  it('Close transition emits `closed`, not `status_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const sql = getTestDb();
    const reason = (await sql`
      SELECT id FROM sell_order_close_reasons WHERE active = TRUE LIMIT 1
    `)[0] as { id: string } | undefined;
    if (!reason) throw new Error('seed lacks active close reason');

    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token,
      body: { to: 'Closed', note: 'customer dropped', closeReasonId: reason.id },
    });
    expect(r.status).toBe(200);

    const events = await eventsOf(id);
    expect(events.map(e => e.kind)).toEqual(['created', 'closed']);
  });

  it('idempotent status transition (same status twice) emits only one event', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 's' } });
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 's' } });

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_changed');
    expect(events).toHaveLength(1);
  });

  it('PUT status-meta note emits `status_meta_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PUT', `/api/sell-orders/${id}/status-meta/Shipped`, {
      token, body: { note: 'tracking 1Z999' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_meta_changed');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({
      status: 'Shipped',
      field: 'note',
    });
  });

  it('POST status-meta attachment emits `status_meta_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const file = new File([readFileSync(pdf)], 'invoice.pdf', { type: 'application/pdf' });
    const r = await multipart(`/api/sell-orders/${id}/status-meta/Shipped/attachments`, { file }, { token });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_meta_changed');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({
      status: 'Shipped',
      field: 'attachment_added',
      filename: 'invoice.pdf',
    });
  });
});
