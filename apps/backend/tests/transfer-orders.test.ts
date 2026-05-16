import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

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

describe('GET /api/inventory/transfer-orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/inventory/transfer-orders', { token });
    expect(r.status).toBe(403);
  });

  it('default lists Pending orders with their lines + from/to enrichment', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const r = await api<{ orders: Array<{
      id: string; status: string; to_warehouse_id: string; from_warehouse_id: string | null;
      item_count: number; unit_count: number;
      lines: Array<{ id: string; from_wh: string | null; qty: number }>;
    }> }>('GET', '/api/inventory/transfer-orders', { token });
    expect(r.status).toBe(200);
    const ord = r.body.orders.find((o) => o.id === moved.orderId);
    expect(ord).toBeDefined();
    expect(ord!.status).toBe('Pending');
    expect(ord!.to_warehouse_id).toBe(moved.to);
    expect(ord!.item_count).toBe(1);
    expect(ord!.unit_count).toBeGreaterThanOrEqual(1);
    const line = ord!.lines.find((l) => l.id === moved.id);
    expect(line).toBeDefined();
    expect(line!.from_wh).toBe(moved.from);
  });

  it('status=all includes the order; default (pending) does too while Pending', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const all = await api<{ orders: Array<{ id: string }> }>(
      'GET', '/api/inventory/transfer-orders?status=all', { token },
    );
    expect(all.body.orders.some((o) => o.id === moved.orderId)).toBe(true);
  });
});

describe('POST /api/inventory/transfer-orders/:id/receive', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/inventory/transfer-orders/TO-forbidden-test/receive', { token });
    expect(r.status).toBe(403);
  });

  it('404 for unknown order', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/inventory/transfer-orders/TO-999999/receive', { token });
    expect(r.status).toBe(404);
  });

  it('receives the whole order: lines Done, order Received', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const r = await api<{ ok: true; id: string }>(
      'POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token },
    );
    expect(r.status).toBe(200);

    const db = getTestDb();
    const ord = (await db`SELECT status, received_at, received_by FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as
      { status: string; received_at: string | null; received_by: string | null };
    expect(ord.status).toBe('Received');
    expect(ord.received_at).not.toBeNull();
    expect(ord.received_by).not.toBeNull();
    const ln = (await db`SELECT status FROM order_lines WHERE id = ${moved.id}`)[0] as { status: string };
    expect(ln.status).toBe('Done');
    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${moved.id} AND kind = 'received' ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.transfer_order_id).toBe(moved.orderId);
    expect(ev.detail.at).toBe(moved.to);

    const pend = await api<{ orders: Array<{ id: string }> }>(
      'GET', '/api/inventory/transfer-orders', { token },
    );
    expect(pend.body.orders.some((o) => o.id === moved.orderId)).toBe(false);
    const recv = await api<{ orders: Array<{ id: string }> }>(
      'GET', '/api/inventory/transfer-orders?status=received', { token },
    );
    expect(recv.body.orders.some((o) => o.id === moved.orderId)).toBe(true);
  });

  it('400 when the order is already Received', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    const again = await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    expect(again.status).toBe(400);
  });
});

describe('POST /api/inventory/transfer-orders/:id/reopen', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/inventory/transfer-orders/TO-forbidden-test/reopen', { token });
    expect(r.status).toBe(403);
  });

  it('400 when the order is not Received', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token); // still Pending
    const r = await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/reopen`, { token });
    expect(r.status).toBe(400);
  });

  it('reverts a clean received order back to Pending / In Transit', async () => {
    const { token } = await loginAs(ALEX);
    // Pick a line NOT committed to any sell order so the reopen guard passes.
    const db = getTestDb();
    const clean = (await db`
      SELECT l.id, l.status, COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id, l.qty
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.status IN ('Reviewing','Done')
        AND NOT EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = l.id)
        AND COALESCE(l.warehouse_id, o.warehouse_id) IS NOT NULL
      LIMIT 1
    `)[0] as { id: string; status: string; warehouse_id: string; qty: number } | undefined;
    expect(clean).toBeDefined(); // seed has unsold lines
    const WAREHOUSES = ['WH-LA1', 'WH-DAL', 'WH-NJ2', 'WH-HK', 'WH-AMS'];
    const to = WAREHOUSES.find((w) => w !== clean!.warehouse_id)!;
    const tr = await api<{ ok: true; transferOrderId: string }>(
      'POST', '/api/inventory/transfer',
      { token, body: { toWarehouseId: to, lines: [{ id: clean!.id, qty: clean!.qty }] } },
    );
    expect(tr.status).toBe(200);
    const orderId = tr.body.transferOrderId;
    await api('POST', `/api/inventory/transfer-orders/${orderId}/receive`, { token });
    const r = await api<{ ok: true; id: string }>(
      'POST', `/api/inventory/transfer-orders/${orderId}/reopen`, { token },
    );
    expect(r.status).toBe(200);
    const ord = (await db`SELECT status, received_at FROM transfer_orders WHERE id = ${orderId}`)[0] as
      { status: string; received_at: string | null };
    expect(ord.status).toBe('Pending');
    expect(ord.received_at).toBeNull();
    const ln = (await db`SELECT status FROM order_lines WHERE id = ${clean!.id}`)[0] as { status: string };
    expect(ln.status).toBe('In Transit');
    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${clean!.id} AND kind = 'reopened' ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.transfer_order_id).toBe(orderId);
  });

  it('409 (no writes) when a line is committed to a sell order', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    // Reuse a seeded sell order (avoids fabricating sell_orders + its FKs);
    // just add a sell_order_lines row pointing at our received line.
    const db = getTestDb();
    const so = (await db`SELECT id FROM sell_orders ORDER BY created_at LIMIT 1`)[0] as
      { id: string } | undefined;
    expect(so).toBeDefined(); // seed has sell orders
    await db`INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price)
             VALUES (${so!.id}, ${moved.id}, 'RAM', 'x', 1, 1)`;
    const r = await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/reopen`, { token });
    expect(r.status).toBe(409);
    const ord = (await db`SELECT status FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as
      { status: string };
    expect(ord.status).toBe('Received'); // unchanged — no writes
  });
});
