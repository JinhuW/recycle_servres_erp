import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { firstCustomerId } from './helpers/fixtures';

// A transfer may only move the units no committed sell order names. Moving
// reserved units split them into a clone that the sell order's Done never
// touched, leaving that many phantom units in stock.
describe('POST /api/inventory/transfer — committed units stay put', () => {
  beforeEach(async () => { await resetDb(); });

  async function setup() {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3);
    const reserved = line.qty - 1;
    const so = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId: await firstCustomerId(token),
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample',
          partNumber: 'PN-1', qty: reserved, unitPrice: line.sell_price,
          warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(so.status).toBe(201);
    // The evidence-gated status flow isn't under test; only the commitment is.
    const sql = getTestDb();
    await sql`UPDATE sell_orders SET status = 'Shipped' WHERE id = ${so.body.id}`;
    const [{ wh }] = await sql<{ wh: string }[]>`
      SELECT COALESCE(l.warehouse_id, o.warehouse_id) AS wh
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.id = ${line.id}
    `;
    const dest = ['WH-LA1', 'WH-DAL', 'WH-NJ2'].find((w) => w !== wh)!;
    return { token, line, dest, sql };
  }

  it('refuses a partial move that reaches into reserved units', async () => {
    const { token, line, dest } = await setup();
    const r = await api<{ error: string }>('POST', '/api/inventory/transfer', {
      token, body: { confirmDrafts: true, toWarehouseId: dest, lines: [{ id: line.id, qty: 2 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('only 1 units not committed');
  });

  it('refuses a full move of a line a committed order holds', async () => {
    const { token, line, dest } = await setup();
    const r = await api('POST', '/api/inventory/transfer', {
      token, body: { confirmDrafts: true, toWarehouseId: dest, lines: [{ id: line.id, qty: line.qty }] },
    });
    expect(r.status).toBe(409);
  });

  it('moves the uncommitted remainder and leaves the reservation on the source', async () => {
    const { token, line, dest, sql } = await setup();
    const r = await api('POST', '/api/inventory/transfer', {
      token, body: { confirmDrafts: true, toWarehouseId: dest, lines: [{ id: line.id, qty: 1 }] },
    });
    expect(r.status).toBe(200);
    const [src] = await sql<{ qty: number; status: string }[]>`
      SELECT qty, status FROM order_lines WHERE id = ${line.id}
    `;
    expect(src).toEqual({ qty: line.qty - 1, status: 'Reviewing' });
  });
});
