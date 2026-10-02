import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// M5b regression: POST /api/inventory/transfer validated source lines from a
// snapshot read OUTSIDE the tx, then wrote inside the tx using that stale
// snapshot. Two concurrent transfers of the same line both passed validation
// and both wrote — double-processing (full move) or a CHECK(qty>0) 500
// (partial). The source rows are now re-selected FOR UPDATE and re-validated
// inside the tx, so exactly one transfer wins and none 500s.

type InvRow = { id: string; status: string; warehouse_id: string | null; qty: number };
const WAREHOUSES = ['WH-LA1', 'WH-DAL', 'WH-NJ2', 'WH-HK', 'WH-AMS'];

describe('POST /api/inventory/transfer — concurrent transfer of the same line', () => {
  beforeEach(async () => { await resetDb(); });

  it('lets exactly one concurrent full-move win and never 500s', async () => {
    const { token } = await loginAs(ALEX);

    for (let i = 0; i < 6; i++) {
      const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
      // The seed commits some lines to Shipped sell orders, and a transfer
      // refuses those outright — neither racer would win.
      const committed = new Set((await getTestDb()<{ id: string }[]>`
        SELECT sl.inventory_id AS id FROM sell_order_lines sl
        JOIN sell_orders so ON so.id = sl.sell_order_id
        WHERE so.status IN ('Shipped', 'Awaiting payment')
      `).map(r => r.id));
      const line = inv.body.items.find(
        l => (l.status === 'Reviewing' || l.status === 'Done') && l.warehouse_id && l.qty > 0
          && !committed.has(l.id),
      );
      if (!line) throw new Error('no transferable line in seed');
      const dests = WAREHOUSES.filter(w => w !== line.warehouse_id);
      const [d1, d2] = [dests[0], dests[1]];

      const [a, b] = await Promise.all([
        api('POST', '/api/inventory/transfer', {
          token, body: { confirmDrafts: true, toWarehouseId: d1, lines: [{ id: line.id, qty: line.qty }] },
        }),
        api('POST', '/api/inventory/transfer', {
          token, body: { confirmDrafts: true, toWarehouseId: d2, lines: [{ id: line.id, qty: line.qty }] },
        }),
      ]);

      expect(a.status).not.toBe(500);
      expect(b.status).not.toBe(500);
      const wins = [a, b].filter(r => r.status === 200).length;
      expect(wins).toBe(1); // the same full line can't be moved twice
    }
  });
});
