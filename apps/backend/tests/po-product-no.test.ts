import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// A PO product's # is stored (order_lines.product_no, migration 0169): given
// once when the product is put on the PO, never recomputed, never reused.
describe('PO product #', () => {
  beforeEach(async () => { await resetDb(); });

  type DetailLine = { id: string; no: number; brand: string | null; qty: number };
  const linesOf = async (token: string, id: string) => (await api<{ order: { lines: DetailLine[] } }>(
    'GET', `/api/orders/${id}`, { token })).body.order.lines;

  const ramLine = (brand: string, qty = 1) => ({ category: 'RAM', brand, qty, unitCost: 10, condition: 'New' });

  it('numbers a new PO 1..n in the request order and returns each #', async () => {
    const { token } = await loginAs(MARCUS);
    const brands = ['Samsung', 'Hynix', 'Micron', 'Kingston', 'Crucial'];
    const r = await api<{ id: string; lineIds: string[]; lineNos: number[] }>('POST', '/api/orders', {
      token, body: { category: 'RAM', lines: brands.map(b => ramLine(b)) },
    });
    expect(r.status).toBe(201);
    expect(r.body.lineNos).toEqual([1, 2, 3, 4, 5]);
    const lines = await linesOf(token, r.body.id);
    expect(lines.map(l => [l.no, l.brand])).toEqual(brands.map((b, i) => [i + 1, b]));
    expect(lines.map(l => l.id)).toEqual(r.body.lineIds);
  });

  it('gives an added product the next #, leaves a gap for a removed one, and never reuses a #', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string; lineIds: string[] }>('POST', '/api/orders', {
      token, body: { category: 'RAM', lines: [ramLine('A'), ramLine('B'), ramLine('C')] },
    });
    const id = created.body.id;
    const [, b, c] = created.body.lineIds;

    // The last product goes in the same save that adds one: a MAX + 1 would
    // hand the new product the removed one's #3.
    const first = await api<{ addedLineNos: number[] }>('PATCH', `/api/orders/${id}`, {
      token, body: { removeLineIds: [c], addLines: [ramLine('D')] },
    });
    expect(first.status).toBe(200);
    expect(first.body.addedLineNos).toEqual([4]);

    const second = await api<{ addedLineNos: number[] }>('PATCH', `/api/orders/${id}`, {
      token, body: { removeLineIds: [b], addLines: [ramLine('E'), ramLine('F')] },
    });
    expect(second.body.addedLineNos).toEqual([5, 6]);
    expect((await linesOf(token, id)).map(l => [l.no, l.brand])).toEqual([
      [1, 'A'], [4, 'D'], [5, 'E'], [6, 'F'],
    ]);

    // The timeline names each product by its #.
    const events = await getTestDb()<{ kind: string; detail: { no: number } }[]>`
      SELECT kind, detail FROM order_events
      WHERE order_id = ${id} AND kind IN ('line_added', 'line_removed') ORDER BY created_at, id`;
    expect(events.map(e => [e.kind, e.detail.no])).toEqual(expect.arrayContaining([
      ['line_removed', 3], ['line_added', 4], ['line_removed', 2], ['line_added', 5], ['line_added', 6],
    ]));
  });

  it('numbers a row inserted without one from the order\'s counter', async () => {
    const sql = getTestDb();
    const [{ id }] = await sql<{ id: string }[]>`SELECT id FROM orders ORDER BY id LIMIT 1`;
    const [{ next_product_no: next }] = await sql<{ next_product_no: number }[]>`
      SELECT next_product_no FROM orders WHERE id = ${id}`;
    const [row] = await sql<{ product_no: number }[]>`
      INSERT INTO order_lines (order_id, category, qty, unit_cost, status)
      VALUES (${id}, 'RAM', 1, 1, 'Draft') RETURNING product_no`;
    expect(row.product_no).toBe(next);
    const [after] = await sql<{ next_product_no: number }[]>`SELECT next_product_no FROM orders WHERE id = ${id}`;
    expect(after.next_product_no).toBe(next + 1);
  });

  describe('a partial transfer', () => {
    const WAREHOUSES = ['WH-LA1', 'WH-DAL', 'WH-NJ2', 'WH-HK', 'WH-AMS'];

    // A stocked lot no sell order names, with five units and a warehouse.
    async function stockedLot() {
      const sql = getTestDb();
      const [src] = await sql<{ id: string; order_id: string; product_no: number; wh: string }[]>`
        SELECT l.id, l.order_id, l.product_no, COALESCE(l.warehouse_id, o.warehouse_id) AS wh
        FROM order_lines l JOIN orders o ON o.id = l.order_id
        WHERE l.status IN ('Reviewing', 'Done') AND o.archived_at IS NULL
          AND COALESCE(l.warehouse_id, o.warehouse_id) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = l.id)
        ORDER BY l.id LIMIT 1`;
      await sql`UPDATE order_lines SET qty = 5, qty_purchased = NULL WHERE id = ${src.id}`;
      const [{ next_product_no: next }] = await sql<{ next_product_no: number }[]>`
        SELECT next_product_no FROM orders WHERE id = ${src.order_id}`;
      return { ...src, next, to: WAREHOUSES.find(w => w !== src.wh)! };
    }

    async function split(token: string, lot: Awaited<ReturnType<typeof stockedLot>>) {
      const tr = await api<{ transferOrderId: string }>('POST', '/api/inventory/transfer', {
        token, body: { confirmDrafts: true, toWarehouseId: lot.to, lines: [{ id: lot.id, qty: 2 }] },
      });
      expect(tr.status).toBe(200);
      const [clone] = await getTestDb()<{ id: string; product_no: number }[]>`
        SELECT id, product_no FROM order_lines WHERE transfer_order_id = ${tr.body.transferOrderId}`;
      return { transferOrderId: tr.body.transferOrderId, clone };
    }

    const nextOf = async (orderId: string) => (await getTestDb()<{ n: number }[]>`
      SELECT next_product_no AS n FROM orders WHERE id = ${orderId}`)[0].n;

    it('keeps its source\'s # on the moved part, right after the source, and counts as one product', async () => {
      const { token } = await loginAs(ALEX);
      const lot = await stockedLot();
      const listCount = async () => {
        const r = await api<{ orders: { id: string; lineCount: number }[] }>(
          'GET', '/api/orders?limit=200', { token });
        return r.body.orders.find(o => o.id === lot.order_id)!.lineCount;
      };
      const countBefore = await listCount();

      const { transferOrderId, clone } = await split(token, lot);
      expect(clone.product_no).toBe(lot.product_no);
      expect(await nextOf(lot.order_id)).toBe(lot.next);

      const lines = await linesOf(token, lot.order_id);
      const at = lines.findIndex(l => l.id === lot.id);
      expect(lines[at + 1]).toMatchObject({ id: clone.id, no: lot.product_no });
      expect(await listCount()).toBe(countBefore);

      // Received, the split stays as its own lot under the same #.
      const rec = await api('POST', `/api/inventory/transfer-orders/${transferOrderId}/receive`, { token });
      expect(rec.status).toBe(200);
      const [kept] = await getTestDb()<{ product_no: number }[]>`
        SELECT product_no FROM order_lines WHERE id = ${clone.id}`;
      expect(kept.product_no).toBe(lot.product_no);
    });

    it('leaves no gap when discarded', async () => {
      const { token } = await loginAs(ALEX);
      const lot = await stockedLot();
      const before = (await linesOf(token, lot.order_id)).map(l => [l.id, l.no]);
      const { transferOrderId } = await split(token, lot);

      const r = await api('DELETE', `/api/inventory/transfer-orders/${transferOrderId}`, { token });
      expect(r.status).toBe(200);
      expect((await linesOf(token, lot.order_id)).map(l => [l.id, l.no])).toEqual(before);
      expect(await nextOf(lot.order_id)).toBe(lot.next);
    });

    it('names the product, not its uuid, when it refuses', async () => {
      const { token } = await loginAs(ALEX);
      const lot = await stockedLot();
      const r = await api<{ error: string }>('POST', '/api/inventory/transfer', {
        token, body: { confirmDrafts: true, toWarehouseId: lot.to, lines: [{ id: lot.id, qty: 9 }] },
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(`${lot.order_id} #${lot.product_no} only has 5 units`);
    });
  });

  // 0169 numbered every existing row with ROW_NUMBER over the old rank's key;
  // this pins that the two agree on the shapes that made the rank hard —
  // position ties, gaps, and a clone sharing its source's position.
  it('0169\'s backfill numbers rows exactly as the old rank did', async () => {
    const rows = await getTestDb()<{ row_number: number; rank: number }[]>`
      WITH ol (id, order_id, position, created_at) AS (VALUES
        ('00000000-0000-0000-0000-000000000003'::uuid, 'PO-A', 0, '2026-01-01 00:00'::timestamptz),
        ('00000000-0000-0000-0000-000000000001'::uuid, 'PO-A', 0, '2026-01-01 00:00'::timestamptz),
        ('00000000-0000-0000-0000-000000000002'::uuid, 'PO-A', 0, '2026-01-01 00:00'::timestamptz),
        ('00000000-0000-0000-0000-000000000009'::uuid, 'PO-A', 7, '2026-01-02 00:00'::timestamptz),
        ('00000000-0000-0000-0000-000000000000'::uuid, 'PO-A', 7, '2026-01-03 00:00'::timestamptz),
        ('00000000-0000-0000-0000-000000000005'::uuid, 'PO-A', 50, '2026-01-01 00:00'::timestamptz),
        ('00000000-0000-0000-0000-000000000004'::uuid, 'PO-B', 3, '2026-01-01 00:00'::timestamptz)
      )
      SELECT ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY position, created_at, id)::int AS row_number,
             (SELECT COUNT(*)::int + 1 FROM ol sib
               WHERE sib.order_id = l.order_id
                 AND (sib.position, sib.created_at, sib.id) < (l.position, l.created_at, l.id)) AS rank
      FROM ol l`;
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r.row_number).toBe(r.rank);
  });
});
