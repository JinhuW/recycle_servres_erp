import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

type InvRow = { id: string; status: string; warehouse_id: string | null; qty: number };
const WAREHOUSES = ['WH-LA1', 'WH-DAL', 'WH-NJ2', 'WH-HK', 'WH-AMS'];

async function transferOne(token: string): Promise<{ id: string; from: string; to: string; orderId: string }> {
  const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
  const line = inv.body.items.find(
    (i) => (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id,
  );
  if (!line) throw new Error('no sellable line in seed');
  const to = WAREHOUSES.find((w) => w !== line.warehouse_id)!;
  const r = await api<{ ok: true; transferOrderId: string }>(
    'POST', '/api/inventory/transfer',
    { token, body: { toWarehouseId: to, lines: [{ id: line.id, qty: line.qty }] } },
  );
  expect(r.status).toBe(200);
  expect(typeof r.body.transferOrderId).toBe('string');
  return { id: line.id, from: line.warehouse_id!, to, orderId: r.body.transferOrderId };
}

describe('migration 0028 — transfer_orders schema', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates transfer_orders and order_lines.transfer_order_id', async () => {
    const db = getTestDb();
    const t = await db`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'transfer_orders' AND table_schema = 'public' ORDER BY column_name
    `;
    const cols = t.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'from_warehouse_id', 'to_warehouse_id', 'note',
      'created_by', 'created_at', 'status', 'received_at', 'received_by',
    ]));
    const ol = await db`
      SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name = 'order_lines' AND column_name = 'transfer_order_id' AND table_schema = 'public'
    `;
    expect(ol.length).toBe(1);
  });
});

describe('POST /api/inventory/transfer — creates a transfer order', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates one TO-<n> order and links the moved line', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    expect(moved.orderId).toMatch(/^TO-\d+$/);

    const db = getTestDb();
    const ord = (await db`SELECT * FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as
      Record<string, unknown>;
    expect(ord).toBeDefined();
    expect(ord.status).toBe('Pending');
    expect(ord.to_warehouse_id).toBe(moved.to);
    expect(ord.from_warehouse_id).toBe(moved.from);
    expect(ord.received_at).toBeNull();

    const ln = (await db`SELECT transfer_order_id FROM order_lines WHERE id = ${moved.id}`)[0] as
      { transfer_order_id: string };
    expect(ln.transfer_order_id).toBe(moved.orderId);

    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${moved.id} AND kind = 'transferred'
      ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.transfer_order_id).toBe(moved.orderId);
  });

  it('uses NULL from_warehouse_id when sources differ', async () => {
    const { token } = await loginAs(ALEX);
    const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
    const sellable = inv.body.items.filter(
      (i) => (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id,
    );
    const a = sellable[0]!;
    const b = sellable.find((i) => i.warehouse_id !== a.warehouse_id);
    if (!b) return; // seed lacked two distinct-source sellable lines — nothing to assert
    const to = WAREHOUSES.find((w) => w !== a.warehouse_id && w !== b.warehouse_id)!;
    const r = await api<{ ok: true; transferOrderId: string }>(
      'POST', '/api/inventory/transfer',
      { token, body: { toWarehouseId: to, lines: [
        { id: a.id, qty: a.qty }, { id: b.id, qty: b.qty },
      ] } },
    );
    expect(r.status).toBe(200);
    const db = getTestDb();
    const ord = (await db`SELECT from_warehouse_id FROM transfer_orders WHERE id = ${r.body.transferOrderId}`)[0] as
      { from_warehouse_id: string | null };
    expect(ord.from_warehouse_id).toBeNull();
  });
});
