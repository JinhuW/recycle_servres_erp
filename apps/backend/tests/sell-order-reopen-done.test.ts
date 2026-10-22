// A Done sell order reopens to Awaiting payment: the units the sale consumed
// go back to their lots, held for the order again, and the sale's market data
// points go with it, so Done again sells and records everything exactly once.
// The sale keeps its date throughout.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { createSellOrderOn, signOffAll } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';
import { eventsOf } from './helpers/sellOrderEvents';

type Line = {
  id: string; inventoryId: string | null; category: string; label: string; sub: string | null;
  partNumber: string | null; qty: number; nativeUnitPrice: number; warehouseId: string | null;
  condition: string | null;
};

let mgr: string;

async function lotRow(id: string) {
  return (await getTestDb()<{ qty: number; status: string; qty_purchased: number | null }[]>`
    SELECT qty, status, qty_purchased FROM order_lines WHERE id = ${id}
  `)[0];
}

async function orderRow(id: string) {
  return (await getTestDb()<{ status: string; done_at: Date | null; notes: string | null }[]>`
    SELECT status, done_at, notes FROM sell_orders WHERE id = ${id}
  `)[0];
}

async function soldEvent(lotId: string, sellOrderId: string) {
  return (await getTestDb()<{ detail: Record<string, unknown> }[]>`
    SELECT detail FROM inventory_events
    WHERE order_line_id = ${lotId} AND kind = 'sold' AND detail->>'sellOrder' = ${sellOrderId}
    ORDER BY created_at DESC LIMIT 1
  `)[0].detail;
}

async function heldFor(lotId: string, sellOrderId: string): Promise<number> {
  const [{ held }] = await getTestDb()<{ held: number }[]>`
    SELECT COALESCE(SUM(sol.qty), 0)::int AS held
    FROM sell_order_lines sol JOIN sell_orders so ON so.id = sol.sell_order_id
    WHERE sol.inventory_id = ${lotId} AND so.id = ${sellOrderId}
      AND so.status IN ('Shipped', 'Awaiting payment')
  `;
  return held;
}

const toStatus = (id: string, body: Record<string, unknown>) =>
  api<{ ok?: boolean; error?: string }>('POST', `/api/sell-orders/${id}/status`, { token: mgr, body });

const reopen = (id: string) => toStatus(id, { to: 'Awaiting payment', from: 'Done', note: 'wrong price' });

async function sell(lotId: string, qty: number, partNumber = 'REOPEN-PN', unitPrice = 90): Promise<string> {
  const id = await createSellOrderOn(mgr, lotId, partNumber, qty, unitPrice);
  await signOffAll(id);
  expect((await toStatus(id, { to: 'Done' })).status).toBe(200);
  return id;
}

describe('reopening a Done sell order', () => {
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  it('gives a partly sold lot its units back and holds them for the order', async () => {
    const lot = await freeSellableLine(mgr, 3);
    const before = await lotRow(lot.id);
    const id = await sell(lot.id, 2);
    expect((await lotRow(lot.id)).qty).toBe(before.qty - 2);
    expect(await soldEvent(lot.id, id)).toMatchObject({
      soldQty: 2, priorQty: before.qty, priorStatus: before.status,
    });
    const doneAt = (await orderRow(id)).done_at;

    const r = await reopen(id);
    expect(r.status).toBe(200);
    expect(await lotRow(lot.id)).toMatchObject({ qty: before.qty, status: before.status });
    expect(await heldFor(lot.id, id)).toBe(2);

    const so = await orderRow(id);
    expect(so.status).toBe('Awaiting payment');
    expect(so.done_at).toEqual(doneAt);
    expect(so.notes).toMatch(/Reopened: wrong price$/);

    const reopened = (await eventsOf(id)).filter(e => e.kind === 'reopened');
    expect(reopened).toHaveLength(1);
    expect(reopened[0].detail).toMatchObject({ fromStatus: 'Done', note: 'wrong price' });

    const unsold = await getTestDb()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM inventory_events WHERE order_line_id = ${lot.id} AND kind = 'unsold'
    `;
    expect(unsold).toHaveLength(1);
    expect(unsold[0].detail).toMatchObject({ returnedQty: 2, remainingQty: before.qty, sellOrder: id });
  });

  it('takes a sold-out lot off Sold with exactly the units this order took', async () => {
    const lot = await freeSellableLine(mgr, 2);
    const { qty } = await lotRow(lot.id);
    const first = await sell(lot.id, qty - 1, 'REOPEN-A');
    const second = await sell(lot.id, 1, 'REOPEN-B');
    expect((await lotRow(lot.id)).status).toBe('Sold');

    // The second sale stands, so the lot holds only what the first one took.
    expect((await reopen(first)).status).toBe(200);
    expect(await lotRow(lot.id)).toMatchObject({ status: 'Reviewing', qty: qty - 1, qty_purchased: qty });
    expect(await heldFor(lot.id, first)).toBe(qty - 1);

    // Reopening the second as well adds its unit onto the live lot.
    expect((await reopen(second)).status).toBe(200);
    expect(await lotRow(lot.id)).toMatchObject({ status: 'Reviewing', qty });
  });

  it('withdraws the sale data points, and Done again consumes and records once', async () => {
    const pn = 'REOPEN-DP-001';
    const lotA = await freeSellableLine(mgr, 1);
    const lotB = await freeSellableLine(mgr, 2, new Set([lotA.id]));
    const earlier = await sell(lotA.id, 1, pn, 40);
    const { qty } = await lotRow(lotB.id);
    const id = await sell(lotB.id, 1, pn, 55);

    const sql = getTestDb();
    const ref = async () => (await sql<{ last_price: number | null; last_price_source: string | null }[]>`
      SELECT last_price::float AS last_price, last_price_source FROM ref_prices WHERE part_number = ${pn}
    `)[0];
    const points = async (source: string) => (await sql`
      SELECT 1 FROM ref_price_events WHERE source = ${source}
    `).length;
    expect(await ref()).toEqual({ last_price: 55, last_price_source: `sale:${id}` });
    const doneAt = (await orderRow(id)).done_at;

    expect((await reopen(id)).status).toBe(200);
    expect(await points(`sale:${id}`)).toBe(0);
    expect(await ref()).toEqual({ last_price: 40, last_price_source: `sale:${earlier}` });
    const [reopened] = (await eventsOf(id)).filter(e => e.kind === 'reopened');
    expect(reopened.detail).toMatchObject({ withdrawnPrices: [{ partNumber: pn, price: 55 }] });

    // The sign-offs were kept, so nobody has to sign again for an unchanged order.
    expect((await toStatus(id, { to: 'Done' })).status).toBe(200);
    expect((await lotRow(lotB.id)).qty).toBe(qty - 1);
    expect(await points(`sale:${id}`)).toBe(1);
    expect((await orderRow(id)).done_at).toEqual(doneAt);
  });

  it('needs a note, and refuses an archived order', async () => {
    const lot = await freeSellableLine(mgr, 1);
    const id = await sell(lot.id, 1);

    const bare = await toStatus(id, { to: 'Awaiting payment', from: 'Done' });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/note required/);

    expect((await api('POST', `/api/sell-orders/${id}/archive`, { token: mgr })).status).toBe(200);
    const archived = await reopen(id);
    expect(archived.status).toBe(409);
    expect(archived.body.error).toMatch(/unarchive/);
    expect((await orderRow(id)).status).toBe('Done');
  });

  it('refuses, changing nothing, when a lot can no longer take its units back', async () => {
    const lot = await freeSellableLine(mgr, 3);
    const id = await sell(lot.id, 2);
    const sold = await lotRow(lot.id);
    await getTestDb()`UPDATE order_lines SET status = 'In Transit' WHERE id = ${lot.id}`;

    const r = await reopen(id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/not sellable \(status=In Transit\)/);
    expect((await lotRow(lot.id)).qty).toBe(sold.qty);
    expect((await orderRow(id)).status).toBe('Done');
    expect((await eventsOf(id)).some(e => e.kind === 'reopened')).toBe(false);
  });

  it('is editable once reopened, and Done moves back nowhere else', async () => {
    const lot = await freeSellableLine(mgr, 2);
    const id = await sell(lot.id, 1);

    for (const to of ['Draft', 'Shipped']) {
      const r = await toStatus(id, { to, note: 'x' });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/illegal transition/);
    }
    const close = await toStatus(id, { to: 'Closed', note: 'x', closeReasonId: 'other' });
    expect(close.status).toBe(409);

    expect((await reopen(id)).status).toBe(200);
    const got = await api<{ order: { linesVersion: string; lines: Line[] } }>(
      'GET', `/api/sell-orders/${id}`, { token: mgr });
    const lines = got.body.order.lines.map(l => ({
      id: l.id, inventoryId: l.inventoryId, category: l.category, label: l.label, subLabel: l.sub,
      partNumber: l.partNumber, qty: 2, unitPrice: l.nativeUnitPrice,
      warehouseId: l.warehouseId, condition: l.condition,
    }));
    const saved = await api('PATCH', `/api/sell-orders/${id}`, {
      token: mgr, body: { lines, linesVersion: got.body.order.linesVersion },
    });
    expect(saved.status).toBe(200);
    expect(await heldFor(lot.id, id)).toBe(2);
  });

  it('reopens only when asked to: a save from a stale editor leaves the sale alone', async () => {
    const lot = await freeSellableLine(mgr, 2);
    const id = await sell(lot.id, 1);
    const { qty } = await lotRow(lot.id);

    // The editor's save of a move it picked while the order was Shipped.
    const stale = await toStatus(id, { to: 'Awaiting payment', from: 'Shipped', note: 'billed' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/is Done now/);
    const unnamed = await toStatus(id, { to: 'Awaiting payment', note: 'billed' });
    expect(unnamed.status).toBe(409);
    expect(unnamed.body.error).toMatch(/reopen it/);

    expect((await orderRow(id)).status).toBe('Done');
    expect((await lotRow(lot.id)).qty).toBe(qty);
  });

  it('never gives a lot back more than it had when the sale oversold it', async () => {
    const lot = await freeSellableLine(mgr, 2);
    const { qty } = await lotRow(lot.id);
    const id = await createSellOrderOn(mgr, lot.id, 'REOPEN-OVER', qty);
    expect((await toStatus(id, { to: 'Awaiting payment' })).status).toBe(200);
    // The PO line is cut below what the committed order holds, then sold.
    await getTestDb()`UPDATE order_lines SET qty = ${qty - 1} WHERE id = ${lot.id}`;
    await signOffAll(id);
    expect((await toStatus(id, { to: 'Done' })).status).toBe(200);
    expect(await lotRow(lot.id)).toMatchObject({ status: 'Sold', qty: qty - 1 });

    expect((await reopen(id)).status).toBe(200);
    expect(await lotRow(lot.id)).toMatchObject({ status: 'Reviewing', qty: qty - 1 });
  });

  it('falls back to the sold-out qty for a sale recorded before priorQty', async () => {
    const lot = await freeSellableLine(mgr, 2);
    const { qty } = await lotRow(lot.id);
    const id = await createSellOrderOn(mgr, lot.id, 'REOPEN-LEGACY', qty);
    expect((await toStatus(id, { to: 'Awaiting payment' })).status).toBe(200);
    await getTestDb()`UPDATE order_lines SET qty = ${qty - 1} WHERE id = ${lot.id}`;
    await signOffAll(id);
    expect((await toStatus(id, { to: 'Done' })).status).toBe(200);
    // The ledger is append-only, so a later row in the old shape stands in.
    await getTestDb()`
      INSERT INTO inventory_events (order_line_id, kind, detail, created_at)
      VALUES (${lot.id}, 'sold',
              ${getTestDb().json({ soldQty: qty, remainingQty: 0, sellOrder: id })},
              NOW() + INTERVAL '1 second')
    `;

    expect((await reopen(id)).status).toBe(200);
    expect(await lotRow(lot.id)).toMatchObject({ status: 'Reviewing', qty: qty - 1 });
  });

  it('returns a sold-out lot to the status it was sold from, not its PO stage', async () => {
    const lot = await freeSellableLine(mgr, 1);
    const { qty } = await lotRow(lot.id);
    const sql = getTestDb();
    // Confirmed stock on a PO that has since gone back to Reviewing.
    await sql`UPDATE order_lines SET status = 'Done' WHERE id = ${lot.id}`;
    const id = await sell(lot.id, qty);
    expect((await lotRow(lot.id)).status).toBe('Sold');
    await sql`UPDATE orders SET lifecycle = 'reviewing' WHERE id = (SELECT order_id FROM order_lines WHERE id = ${lot.id})`;

    expect((await reopen(id)).status).toBe(200);
    expect(await lotRow(lot.id)).toMatchObject({ status: 'Done', qty });
  });

  it('waits for an open after-sales case to close', async () => {
    const lot = await freeSellableLine(mgr, 1);
    const id = await sell(lot.id, 1);
    const sql = getTestDb();
    await sql`INSERT INTO after_sales_cases (id, sell_order_id, issue) VALUES ('AS-T1', ${id}, 'scratched')`;

    const r = await reopen(id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/after-sales case AS-T1 is open/);
    expect((await orderRow(id)).status).toBe('Done');

    await sql`UPDATE after_sales_cases SET status = 'Resolved', closed_at = NOW() WHERE id = 'AS-T1'`;
    expect((await reopen(id)).status).toBe(200);
  });

  it('goes back to Done, never to Closed', async () => {
    const lot = await freeSellableLine(mgr, 1);
    const id = await sell(lot.id, 1);
    expect((await reopen(id)).status).toBe(200);

    const close = await toStatus(id, { to: 'Closed', note: 'x', closeReasonId: 'other' });
    expect(close.status).toBe(409);
    expect(close.body.error).toMatch(/was Done/);
    expect((await orderRow(id)).status).toBe('Awaiting payment');

    const got = await api<{ order: { doneAt: string | null } }>('GET', `/api/sell-orders/${id}`, { token: mgr });
    expect(got.body.order.doneAt).not.toBeNull();
  });
});
