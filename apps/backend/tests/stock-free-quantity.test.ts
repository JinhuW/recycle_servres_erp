import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { createSellOrderOn } from './helpers/fixtures';

// One rule for "how much of this line is free": its qty less the units
// committed sell orders (Shipped, Awaiting payment) name. Every surface that
// moves or edits stock has to read the same number.

const ship = (token: string, id: string) =>
  api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 's' } });

async function lineOrder(lineId: string): Promise<string> {
  const [r] = await getTestDb()<{ order_id: string }[]>`SELECT order_id FROM order_lines WHERE id = ${lineId}`;
  return r.order_id;
}

async function lineQty(lineId: string): Promise<{ qty: number; qty_purchased: number | null }> {
  const [r] = await getTestDb()<{ qty: number; qty_purchased: number | null }[]>`
    SELECT qty, qty_purchased FROM order_lines WHERE id = ${lineId}`;
  return r;
}

async function otherWarehouse(token: string, lineId: string): Promise<string> {
  const [r] = await getTestDb()<{ wh: string | null }[]>`
    SELECT COALESCE(l.warehouse_id, o.warehouse_id) AS wh
    FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ${lineId}`;
  const whs = await api<{ items: { id: string }[] }>('GET', '/api/warehouses', { token });
  return whs.body.items.find((w) => w.id !== r.wh)!.id;
}

describe('a partly committed line', () => {
  beforeEach(async () => { await resetDb(); });

  it('reads the same free quantity in the picker, the transfer and both editors', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 4);
    const committed = 2;
    const so = await createSellOrderOn(token, line.id, 'PN-FREE', committed);
    expect((await ship(token, so)).status).toBe(200);

    const sellable = await api<{ items: { inventoryId: string; availableQty: number }[] }>(
      'GET', '/api/sell-orders/sellable', { token });
    expect(sellable.body.items.find((i) => i.inventoryId === line.id)?.availableQty)
      .toBe(line.qty - committed);

    const listed = await api<{ items: { id: string; committed_qty?: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    expect(listed.body.items.find((i) => i.id === line.id)?.committed_qty).toBe(committed);

    // Moving more than the free units is refused; the free units move.
    const to = await otherWarehouse(token, line.id);
    const over = await api('POST', '/api/inventory/transfer', {
      token, body: { toWarehouseId: to, lines: [{ id: line.id, qty: line.qty - committed + 1 }] },
    });
    expect(over.status).toBe(409);

    // Inventory editor: a recount may not drop below the committed units, and
    // the status can't move while any are committed; a recount above is fine.
    const tooLow = await api<{ committedQty?: number }>('PATCH', `/api/inventory/${line.id}`, {
      token, body: { qty: committed - 1 },
    });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.committedQty).toBe(committed);
    expect((await api('PATCH', `/api/inventory/${line.id}`, { token, body: { status: 'Done' } })).status).toBe(409);
    expect((await api('PATCH', `/api/inventory/${line.id}`, { token, body: { qty: committed } })).status).toBe(200);

    // PO editor: the same floor, naming the sell order to a manager.
    const orderId = await lineOrder(line.id);
    const po = await api<{ sellOrderIds?: string[]; offendingLineIds?: string[] }>(
      'PATCH', `/api/orders/${orderId}`, { token, body: { lines: [{ id: line.id, qty: committed - 1 }] } });
    expect(po.status).toBe(409);
    expect(po.body.sellOrderIds).toEqual([so]);
    expect(po.body.offendingLineIds).toEqual([line.id]);
  });

  it('keeps the sold count when a partly sold line is recounted', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3);
    const so = await createSellOrderOn(token, line.id, 'PN-RECOUNT', 1);
    expect((await api('POST', `/api/sell-orders/${so}/status`, { token, body: { to: 'Done', note: 'paid' } })).status)
      .toBe(200);
    const sold = await lineQty(line.id);
    expect(sold).toEqual({ qty: line.qty - 1, qty_purchased: line.qty });

    const orderId = await lineOrder(line.id);
    expect((await api('PATCH', `/api/orders/${orderId}`, {
      token, body: { lines: [{ id: line.id, qty: sold.qty + 2 }] },
    })).status).toBe(200);
    expect(await lineQty(line.id)).toEqual({ qty: sold.qty + 2, qty_purchased: line.qty + 2 });

    expect((await api('PATCH', `/api/inventory/${line.id}`, { token, body: { qty: sold.qty } })).status).toBe(200);
    expect(await lineQty(line.id)).toEqual({ qty: sold.qty, qty_purchased: line.qty });
  });
});

describe('moving a whole line a Draft names', () => {
  beforeEach(async () => { await resetDb(); });

  it('names the drafts first and moves once confirmed', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const draft = await createSellOrderOn(token, line.id, 'PN-DRAFT', 1);
    const to = await otherWarehouse(token, line.id);
    const body = { toWarehouseId: to, lines: [{ id: line.id, qty: line.qty }] };

    const asked = await api<{ needsConfirm?: boolean; drafts?: string[] }>(
      'POST', '/api/inventory/transfer', { token, body });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ needsConfirm: true, drafts: [draft] });
    expect((await lineQty(line.id)).qty).toBe(line.qty);

    const moved = await api('POST', '/api/inventory/transfer', { token, body: { ...body, confirmDrafts: true } });
    expect(moved.status).toBe(200);
  });
});

describe('POST /api/orders/:id/total-cost/follow-lines', () => {
  beforeEach(async () => { await resetDb(); });

  it('lets a manager drop a pinned lot price, and audits it', async () => {
    const { token } = await loginAs(ALEX);
    const sql = getTestDb();
    const [po] = await sql<{ id: string; sum: number }[]>`
      SELECT o.id, SUM(COALESCE(l.qty_purchased, l.qty) * l.unit_cost)::float AS sum
      FROM orders o JOIN order_lines l ON l.order_id = o.id
      WHERE o.archived_at IS NULL
      GROUP BY o.id ORDER BY o.id LIMIT 1`;
    await sql`UPDATE orders SET total_cost = ${po.sum + 100} WHERE id = ${po.id}`;

    type Detail = { order: { goodsFollowsLines?: boolean; totalCost: number | null } };
    expect((await api<Detail>('GET', `/api/orders/${po.id}`, { token })).body.order.goodsFollowsLines).toBe(false);

    const { token: purchaser } = await loginAs(MARCUS);
    expect((await api('POST', `/api/orders/${po.id}/total-cost/follow-lines`, { token: purchaser, body: {} })).status)
      .toBe(403);

    const r = await api<{ totalCost: number }>('POST', `/api/orders/${po.id}/total-cost/follow-lines`, { token, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.totalCost).toBeCloseTo(po.sum, 2);
    const after = await api<Detail>('GET', `/api/orders/${po.id}`, { token });
    expect(after.body.order.goodsFollowsLines).toBe(true);

    const events = await api<{ events: { kind: string; detail: { changes?: { field: string }[] } }[] }>(
      'GET', `/api/orders/${po.id}/events`, { token });
    expect(events.body.events.some((e) => e.kind === 'meta_changed'
      && e.detail.changes?.some((ch) => ch.field === 'total_cost'))).toBe(true);
  });

  it('reports a partly sold PO whose total mirrors what was bought as following its lines', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3);
    const so = await createSellOrderOn(token, line.id, 'PN-MIRROR', 1);
    expect((await api('POST', `/api/sell-orders/${so}/status`, { token, body: { to: 'Done', note: 'paid' } })).status)
      .toBe(200);
    const orderId = await lineOrder(line.id);
    const d = await api<{ order: { goodsFollowsLines?: boolean } }>('GET', `/api/orders/${orderId}`, { token });
    expect(d.body.order.goodsFollowsLines).toBe(true);
  });
});
