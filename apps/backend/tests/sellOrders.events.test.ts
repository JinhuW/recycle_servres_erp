import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { eventsOf } from './helpers/sellOrderEvents';

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
});
