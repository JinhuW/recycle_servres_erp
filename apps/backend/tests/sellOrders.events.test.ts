import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

async function eventsOf(sellOrderId: string): Promise<Array<{ kind: string; detail: Record<string, unknown>; actor_id: string | null }>> {
  const sql = getTestDb();
  return await sql`
    SELECT kind, detail, actor_id FROM sell_order_events
    WHERE sell_order_id = ${sellOrderId}
    ORDER BY created_at ASC, id ASC
  ` as unknown as Array<{ kind: string; detail: Record<string, unknown>; actor_id: string | null }>;
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
});
