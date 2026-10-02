import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { firstCustomerId } from './helpers/fixtures';

// Sorts before every real uuid, so a clone carrying it would rank ahead of its
// source if id were the only tie-break after position.
const LOWEST_UUID = '00000000-0000-0000-0000-000000000000';

// A line's number is whatever the PO page shows: its index in
// GET /api/orders/:id. Every reader is checked against that, not against
// literal numbers — the seed decides how many lines the PO already has.
describe('PO line number on sell order lines', () => {
  beforeEach(async () => { await resetDb(); });

  it('matches the PO page across position gaps, ties and a transfer clone', async () => {
    const { token } = await loginAs(ALEX);
    const sql = getTestDb();
    const seed = await freeSellableLine(token);
    const [{ order_id: poId }] = await sql<{ order_id: string }[]>`
      SELECT order_id FROM order_lines WHERE id = ${seed.id}`;

    // Three lots tied at position 0 — inserted in one statement, so they share
    // created_at as well and only id orders them.
    const tied = (await sql<{ id: string }[]>`
      INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, part_number, status, position)
      SELECT ${poId}, 'RAM', 2, 10, 20, 'PN-RS145-' || g, 'Reviewing', 0
      FROM generate_series(1, 3) g
      RETURNING id`).map(r => r.id);
    // A gap: the seed moves well past everything else.
    await sql`UPDATE order_lines SET position = position + 50 WHERE id = ${seed.id}`;

    const poLines = async () => (await api<{ order: { lines: { id: string }[] } }>(
      'GET', `/api/orders/${poId}`, { token })).body.order.lines.map(l => l.id);
    const noOf = (ids: string[], id: string) => ids.indexOf(id) + 1;

    const before = await poLines();
    const source = tied[0];
    const sourceNo = noOf(before, source);
    expect(sourceNo).toBeGreaterThan(0);

    // A partial transfer clones a lot at its source's position, later.
    await sql`
      INSERT INTO order_lines (id, order_id, category, qty, unit_cost, sell_price, part_number,
                               status, position, created_at)
      SELECT ${LOWEST_UUID}, order_id, category, 1, unit_cost, sell_price, part_number,
             status, position, created_at + interval '1 hour'
      FROM order_lines WHERE id = ${source}`;

    const after = await poLines();
    expect(noOf(after, source)).toBe(sourceNo);
    expect(noOf(after, LOWEST_UUID)).toBeGreaterThan(sourceNo);

    const lots = [...tied, seed.id, LOWEST_UUID];
    const customerId = await firstCustomerId(token);
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [
          ...lots.map(id => ({
            inventoryId: id, category: 'RAM', label: 'Sample', partNumber: 'PN-1',
            qty: 1, unitPrice: 20, warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
          })),
          { inventoryId: null, category: 'Other', label: 'Rails', qty: 1, unitPrice: 10 },
        ],
      },
    });
    expect(created.status).toBe(201);

    type Line = { inventoryId: string | null; sourceOrderId: string | null; sourceLineNo: number | null };
    const got = await api<{ order: { lines: Line[] } }>(
      'GET', `/api/sell-orders/${created.body.id}`, { token });
    expect(got.status).toBe(200);
    for (const id of lots) {
      const l = got.body.order.lines.find(x => x.inventoryId === id)!;
      expect(l.sourceOrderId).toBe(poId);
      expect(l.sourceLineNo).toBe(noOf(after, id));
    }
    const typed = got.body.order.lines.find(l => l.inventoryId === null)!;
    expect(typed.sourceLineNo).toBeNull();

    // The picker and Inventory → Add to sell order read the same number.
    const sellable = await api<{ items: { inventoryId: string; sourceLineNo: number }[] }>(
      'GET', '/api/sell-orders/sellable?q=PN-RS145', { token });
    for (const id of [...tied, LOWEST_UUID]) {
      expect(sellable.body.items.find(i => i.inventoryId === id)?.sourceLineNo).toBe(noOf(after, id));
    }
    const inv = await api<{ items: { id: string; po_line_no: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    for (const id of lots) {
      expect(inv.body.items.find(i => i.id === id)?.po_line_no).toBe(noOf(after, id));
    }
  });
});
