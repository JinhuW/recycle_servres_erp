// Archiving a PO takes its goods out of stock: every non-Sold line moves to
// 'Archived', unarchive puts each line back where it was, and a line an open
// sell order still names has to be released from that sell order first.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { eventsOf } from './helpers/sellOrderEvents';

type Line = { id: string; status: string; qty: number; partNumber: string | null };
type Detail = { order: { lifecycle: string; archivedAt: string | null; lines: Line[] } };
type Conflict = {
  error: string;
  code?: string;
  sellOrders?: { id: string; status: string; lineCount: number; lines: { solId: string; inventoryId: string; label: string; qty: number }[] }[];
  offendingLineIds?: string[];
};

// A part number no seed row carries, so the sellable search can be asked for
// exactly these lines.
const PN = 'ARCHV-TEST-PN';

async function createReviewing(pur: string, mgr: string): Promise<{ id: string; lineIds: string[] }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001',
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [
        { category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5 },
        { category: 'RAM', brand: 'Samsung', capacity: '16GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 2, unitCost: 40 },
      ],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, {
    token: mgr, body: { toStage: 'reviewing' },
  })).status).toBe(200);
  const got = await api<Detail>('GET', `/api/orders/${id}`, { token: mgr });
  return { id, lineIds: got.body.order.lines.map(l => l.id) };
}

const get = (id: string, token: string) => api<Detail>('GET', `/api/orders/${id}`, { token });

async function createSellOrderOn(mgr: string, lineId: string, qty = 1): Promise<string> {
  const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token: mgr });
  const so = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: mgr,
    body: {
      customerId: customers.body.items[0].id,
      lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: PN, qty, unitPrice: 90 }],
    },
  });
  expect(so.status).toBe(201);
  return so.body.id;
}

async function statusesOf(id: string, token: string): Promise<Record<string, string>> {
  const got = await get(id, token);
  return Object.fromEntries(got.body.order.lines.map(l => [l.id, l.status]));
}

describe('archive takes the lines out of stock', () => {
  beforeEach(async () => { await resetDb(); });

  it('moves every line to Archived, hides them from stock and sellable, and lists them under ?status=Archived', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);

    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr })).status).toBe(200);

    const st = await statusesOf(id, mgr);
    for (const l of lineIds) expect(st[l]).toBe('Archived');

    const inv = await api<{ items: { id: string }[] }>('GET', `/api/inventory?q=${PN.toLowerCase()}`, { token: mgr });
    expect(inv.body.items.map(i => i.id)).toEqual([]);
    const archived = await api<{ items: { id: string }[] }>(
      'GET', `/api/inventory?q=${PN.toLowerCase()}&status=Archived`, { token: mgr });
    expect(archived.body.items.map(i => i.id).sort()).toEqual([...lineIds].sort());

    const sellable = await api<{ items: { id: string }[] }>(
      'GET', `/api/sell-orders/sellable?q=${PN.toLowerCase()}`, { token: mgr });
    expect(sellable.body.items).toEqual([]);

    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token: mgr });
    const so = await api<{ error: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId: customers.body.items[0].id,
        lines: [{ inventoryId: lineIds[0], category: 'RAM', label: 'x', partNumber: PN, qty: 1, unitPrice: 90 }],
      },
    });
    expect(so.status).toBe(400);
    expect(so.body.error).toMatch(/not sellable/);
  });

  it('records one status event per line on the archive, and the archived order event carries the count', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr })).status).toBe(200);

    const sql = getTestDb();
    const rows = await sql<{ order_line_id: string; detail: { from: string; to: string } }[]>`
      SELECT order_line_id, detail FROM inventory_events
      WHERE order_line_id = ANY(${lineIds}::uuid[]) AND kind = 'status' AND detail->>'to' = 'Archived'
    `;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.detail.from).toBe('Reviewing');

    const events = await api<{ events: { kind: string; detail: { lines?: number } }[] }>(
      'GET', `/api/orders/${id}/events`, { token: mgr });
    const archived = events.body.events.find(e => e.kind === 'archived');
    expect(archived?.detail.lines).toBe(2);
  });

  it('unarchive restores each line to the status it had, not one status for the whole order', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    // One line already confirmed by hand — the PO is still Reviewing.
    expect((await api('PATCH', `/api/inventory/${lineIds[0]}`, {
      token: mgr, body: { status: 'Done' },
    })).status).toBe(200);

    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr })).status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/unarchive`, { token: mgr })).status).toBe(200);

    const st = await statusesOf(id, mgr);
    expect(st[lineIds[0]]).toBe('Done');
    expect(st[lineIds[1]]).toBe('Reviewing');
    const got = await get(id, mgr);
    expect(got.body.order.archivedAt).toBeNull();
  });

  it('leaves a Sold line alone on both archive and unarchive', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    // Sell the whole second lot: Done flips the line to Sold.
    const soId = await createSellOrderOn(mgr, lineIds[1], 2);
    expect((await api('POST', `/api/sell-orders/${soId}/status`, {
      token: mgr, body: { to: 'Done' },
    })).status).toBe(200);
    expect((await statusesOf(id, mgr))[lineIds[1]]).toBe('Sold');

    // A Done sell order is not "open": no prompt, nothing to remove.
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr })).status).toBe(200);
    let st = await statusesOf(id, mgr);
    expect(st[lineIds[0]]).toBe('Archived');
    expect(st[lineIds[1]]).toBe('Sold');

    expect((await api('POST', `/api/orders/${id}/unarchive`, { token: mgr })).status).toBe(200);
    st = await statusesOf(id, mgr);
    expect(st[lineIds[0]]).toBe('Reviewing');
    expect(st[lineIds[1]]).toBe('Sold');
  });
});

describe('archive and open sell orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses with the sell orders and lines involved, and changes nothing', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);
    expect((await api('POST', `/api/sell-orders/${soId}/status`, {
      token: mgr, body: { to: 'Shipped' },
    })).status).toBe(200);

    const r = await api<Conflict>('POST', `/api/orders/${id}/archive`, { token: mgr });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('committedLines');
    expect(r.body.sellOrders).toHaveLength(1);
    expect(r.body.sellOrders?.[0].id).toBe(soId);
    expect(r.body.sellOrders?.[0].status).toBe('Shipped');
    expect(r.body.sellOrders?.[0].lineCount).toBe(1);
    expect(r.body.sellOrders?.[0].lines).toEqual([
      { solId: expect.any(String), inventoryId: lineIds[0], label: 'x', qty: 1 },
    ]);

    const got = await get(id, mgr);
    expect(got.body.order.archivedAt).toBeNull();
    for (const l of got.body.order.lines) expect(l.status).toBe('Reviewing');
    const so = await api<{ order: { lines: unknown[] } }>('GET', `/api/sell-orders/${soId}`, { token: mgr });
    expect(so.body.order.lines).toHaveLength(1);
  });

  it('with removeFromSellOrders, drops the lines from the sell order, audits it there, then archives', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);

    const r = await api('POST', `/api/orders/${id}/archive`, {
      token: mgr, body: { removeFromSellOrders: true },
    });
    expect(r.status).toBe(200);

    const got = await get(id, mgr);
    expect(got.body.order.archivedAt).not.toBeNull();
    for (const l of got.body.order.lines) expect(l.status).toBe('Archived');

    const so = await api<{ order: { status: string; lines: unknown[] } }>(
      'GET', `/api/sell-orders/${soId}`, { token: mgr });
    expect(so.status).toBe(200);
    expect(so.body.order.lines).toHaveLength(0);

    const removed = (await eventsOf(soId)).filter(e => e.kind === 'line_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].detail.reason).toBe('po_archived');
    expect(removed[0].detail.orderId).toBe(id);
    expect((removed[0].detail.snapshot as { inventory_id: string }).inventory_id).toBe(lineIds[0]);

    const events = await api<{ events: { kind: string; detail: { removedSellOrderLines?: number } }[] }>(
      'GET', `/api/orders/${id}/events`, { token: mgr });
    expect(events.body.events.find(e => e.kind === 'archived')?.detail.removedSellOrderLines).toBe(1);
  });

  it('an emptied sell order still lists, opens and changes status', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);
    expect((await api('POST', `/api/orders/${id}/archive`, {
      token: mgr, body: { removeFromSellOrders: true },
    })).status).toBe(200);

    const list = await api<{ items: { id: string; total: number }[] }>('GET', '/api/sell-orders', { token: mgr });
    expect(list.status).toBe(200);
    expect(list.body.items.find(i => i.id === soId)?.total).toBe(0);
    const detail = await api<{ order: { subtotal: number } }>('GET', `/api/sell-orders/${soId}`, { token: mgr });
    expect(detail.body.order.subtotal).toBe(0);
    expect((await api('POST', `/api/sell-orders/${soId}/status`, {
      token: mgr, body: { to: 'Closed', closeReasonId: 'other' },
    })).status).toBe(200);
  });

  it('unarchive does not bring the removed sell-order lines back', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);
    expect((await api('POST', `/api/orders/${id}/archive`, {
      token: mgr, body: { removeFromSellOrders: true },
    })).status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/unarchive`, { token: mgr })).status).toBe(200);

    expect((await statusesOf(id, mgr))[lineIds[0]]).toBe('Reviewing');
    const so = await api<{ order: { lines: unknown[] } }>('GET', `/api/sell-orders/${soId}`, { token: mgr });
    expect(so.body.order.lines).toHaveLength(0);
  });

  it('a purchaser gets a plain refusal, never the sell orders, and cannot remove anything', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);
    expect((await api('POST', `/api/sell-orders/${soId}/status`, {
      token: mgr, body: { to: 'Shipped' },
    })).status).toBe(200);

    // The owner reaches the endpoint (both shells offer Archive to the owner)
    // but every sell-order read 403s a purchaser, so the 409 must not leak
    // the sell order either.
    const plain = await api<Conflict>('POST', `/api/orders/${id}/archive`, { token: pur });
    expect(plain.status).toBe(409);
    expect(plain.body.error).toMatch(/manager/i);
    expect(plain.body.code).toBeUndefined();
    expect(plain.body.sellOrders).toBeUndefined();

    const forced = await api<Conflict>('POST', `/api/orders/${id}/archive`, {
      token: pur, body: { removeFromSellOrders: true },
    });
    expect(forced.status).toBe(409);
    expect(forced.body.sellOrders).toBeUndefined();

    expect((await get(id, mgr)).body.order.archivedAt).toBeNull();
    const so = await api<{ order: { lines: unknown[] } }>('GET', `/api/sell-orders/${soId}`, { token: mgr });
    expect(so.body.order.lines).toHaveLength(1);
    expect((await eventsOf(soId)).filter(e => e.kind === 'line_removed')).toHaveLength(0);
  });

  it('refuses when a line is out on a pending transfer order, with no prompt', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const moved = await api<{ transferOrderId: string }>('POST', '/api/inventory/transfer', {
      token: mgr, body: { toWarehouseId: 'WH-DAL', lines: [{ id: lineIds[0], qty: 4 }] },
    });
    expect(moved.status).toBe(200);

    const r = await api<Conflict>('POST', `/api/orders/${id}/archive`, {
      token: mgr, body: { removeFromSellOrders: true },
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBeUndefined();
    expect(r.body.offendingLineIds).toContain(lineIds[0]);
    expect((await get(id, mgr)).body.order.archivedAt).toBeNull();
  });
});

describe('an archived order is frozen', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses edits, stage moves and inventory line edits until it is unarchived', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr })).status).toBe(200);

    const edit = await api<{ error: string }>('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { notes: 'late note' },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toMatch(/archived/i);

    const adv = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'ready_to_pay' },
    });
    expect(adv.status).toBe(409);
    expect(adv.body.error).toMatch(/archived/i);

    const line = await api<{ error: string }>('PATCH', `/api/inventory/${lineIds[0]}`, {
      token: mgr, body: { sellPrice: 120 },
    });
    expect(line.status).toBe(409);
    expect(line.body.error).toMatch(/archived/i);

    // Nothing moved.
    const got = await get(id, mgr);
    expect(got.body.order.lifecycle).toBe('reviewing');
    for (const l of got.body.order.lines) expect(l.status).toBe('Archived');

    expect((await api('POST', `/api/orders/${id}/unarchive`, { token: mgr })).status).toBe(200);
    expect((await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { notes: 'late note' } })).status).toBe(200);
  });

  it('a Sold line on an archived order cannot be walked back into stock', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[1], 2);
    expect((await api('POST', `/api/sell-orders/${soId}/status`, {
      token: mgr, body: { to: 'Done' },
    })).status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr })).status).toBe(200);

    // The archive leaves the Sold line at Sold, so a guard keyed on the line
    // status would let this through — and the line would be back in the
    // sellable views while the order stays archived.
    const r = await api<{ error: string }>('PATCH', `/api/inventory/${lineIds[1]}`, {
      token: mgr, body: { status: 'Done' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/archived/i);
    expect((await statusesOf(id, mgr))[lineIds[1]]).toBe('Sold');
  });

  it('a hand-set line status can never be Archived', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { lineIds } = await createReviewing(pur, mgr);
    const r = await api('PATCH', `/api/inventory/${lineIds[0]}`, { token: mgr, body: { status: 'Archived' } });
    expect(r.status).toBe(400);
  });
});

// 0121 backfilled the lines of POs archived before the cascade existed; 0122
// repairs the one case it got wrong. Both run before the seed when a worker
// builds its template, so the test replays the real files over data it makes.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const M0121 = readFileSync(join(MIGRATIONS, '0121_archived_po_lines.sql'), 'utf8');
const M0122 = readFileSync(join(MIGRATIONS, '0122_archived_lines_on_pending_transfer.sql'), 'utf8');

describe('0121 + 0122 — backfilling POs archived before the cascade', () => {
  beforeEach(async () => { await resetDb(); });

  it('puts a line 0121 stranded on a pending transfer back at In Transit, with its audit row', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const moved = await api<{ transferOrderId: string }>('POST', '/api/inventory/transfer', {
      token: mgr, body: { toWarehouseId: 'WH-DAL', lines: [{ id: lineIds[0], qty: 4 }] },
    });
    expect(moved.status).toBe(200);
    expect((await statusesOf(id, mgr))[lineIds[0]]).toBe('In Transit');

    // A pre-v1.137 archive: the flag alone, lines untouched.
    const sql = getTestDb();
    await sql`UPDATE orders SET archived_at = NOW() WHERE id = ${id}`;

    await sql.unsafe(M0121);
    let st = await statusesOf(id, mgr);
    expect(st[lineIds[0]]).toBe('Archived');
    expect(st[lineIds[1]]).toBe('Archived');

    await sql.unsafe(M0122);
    st = await statusesOf(id, mgr);
    expect(st[lineIds[0]]).toBe('In Transit');
    expect(st[lineIds[1]]).toBe('Archived');
    const audit = await sql<{ detail: { from: string; to: string } }[]>`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${lineIds[0]} AND kind = 'status'
      ORDER BY created_at DESC LIMIT 1`;
    expect(audit[0]?.detail).toMatchObject({ from: 'Archived', to: 'In Transit' });

    // Which is exactly what receive needs to find.
    const received = await api('POST', `/api/inventory/transfer-orders/${moved.body.transferOrderId}/receive`, { token: mgr });
    expect(received.status).toBe(200);
    expect((await statusesOf(id, mgr))[lineIds[0]]).toBe('Done');

    // Running the repair again touches nothing.
    await sql.unsafe(M0122);
    expect((await statusesOf(id, mgr))[lineIds[0]]).toBe('Done');
  });
});
