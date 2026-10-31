// Review 2026-10-31, lane A2 verification. Each case ASSERTS THE CLAIMED
// DEFECT (or, where noted, the behaviour that refutes part of a claim).
// Run: cd docs/review-2026-10-31/repro/A2-verify &&
//   TEST_DATABASE_URL=postgres://postgres:review@127.0.0.1:55712/postgres \
//   ../../../../apps/backend/node_modules/.bin/vitest run --config vitest.config.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from '../../../../apps/backend/tests/helpers/db';
import { api } from '../../../../apps/backend/tests/helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from '../../../../apps/backend/tests/helpers/auth';
import { createSellOrderOn, signOffAll } from '../../../../apps/backend/tests/helpers/fixtures';

const PN = 'A2V-TEST-PN';
type Line = { id: string; status: string; qty: number };
type Detail = { order: { lifecycle: string; archivedAt: string | null; lines: Line[] } };

async function createReviewing(pur: string, mgr: string, wh = 'WH-LA1') {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: wh, payment: 'company',
      lines: [
        { category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5 },
      ],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } })).status).toBe(200);
  const got = await api<Detail>('GET', `/api/orders/${id}`, { token: mgr });
  return { id, lineId: got.body.order.lines[0].id };
}
const lineRow = async (id: string) =>
  (await getTestDb()`SELECT status, qty, warehouse_id, transfer_order_id FROM order_lines WHERE id = ${id}`)[0] as
    { status: string; qty: number; warehouse_id: string | null; transfer_order_id: string | null };

describe('A2 verify', () => {
  beforeEach(async () => { await resetDb(); });

  it('A2-01a: a Sold lot PATCHed back to Done is sold a second time', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { lineId } = await createReviewing(pur, mgr);
    const so1 = await createSellOrderOn(mgr, lineId, PN, 4);
    await signOffAll(so1);
    expect((await api('POST', `/api/sell-orders/${so1}/status`, { token: mgr, body: { to: 'Done' } })).status).toBe(200);
    expect(await lineRow(lineId)).toMatchObject({ status: 'Sold', qty: 4 });

    const p = await api('PATCH', `/api/inventory/${lineId}`, { token: mgr, body: { status: 'Done' } });
    expect(p.status).toBe(200);                       // no guard on leaving Sold
    expect(await lineRow(lineId)).toMatchObject({ status: 'Done', qty: 4 });

    // The same 4 units sell again.
    const so2 = await createSellOrderOn(mgr, lineId, PN, 4);
    await signOffAll(so2);
    expect((await api('POST', `/api/sell-orders/${so2}/status`, { token: mgr, body: { to: 'Done' } })).status).toBe(200);
    const sold = await getTestDb()`
      SELECT COALESCE(SUM(sol.qty),0)::int AS n FROM sell_order_lines sol JOIN sell_orders so ON so.id = sol.sell_order_id
      WHERE sol.inventory_id = ${lineId} AND so.status = 'Done'`;
    expect(sold[0].n).toBe(8);                        // 8 units sold from a 4-unit lot
  });

  it('A2-01b: an In Transit line PATCHed to Done blocks discard, but receive still closes the transfer', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { lineId } = await createReviewing(pur, mgr);
    const t = await api<{ transferOrderId: string }>('POST', '/api/inventory/transfer', {
      token: mgr, body: { confirmDrafts: true, toWarehouseId: 'WH-DAL', lines: [{ id: lineId, qty: 4 }] } });
    expect(t.status).toBe(200);
    const to = t.body.transferOrderId;
    expect((await lineRow(lineId)).status).toBe('In Transit');
    expect((await api('PATCH', `/api/inventory/${lineId}`, { token: mgr, body: { status: 'Done' } })).status).toBe(200);

    expect((await api('DELETE', `/api/inventory/transfer-orders/${to}`, { token: mgr })).status).toBe(409);
    const rec = await api('POST', `/api/inventory/transfer-orders/${to}/receive`, { token: mgr });
    expect(rec.status).toBe(200);                     // not stuck: receive succeeds
    const st = await getTestDb()`SELECT status FROM transfer_orders WHERE id = ${to}`;
    expect(st[0].status).toBe('Received');
  });

  it('A2-02: deleting the source warehouse (no transferTo) makes discard 500', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const db = getTestDb();
    await db`INSERT INTO warehouses (id, name, short, region) VALUES ('WH-A2V', 'A2V', 'A2V', 'US') ON CONFLICT DO NOTHING`;
    const { lineId } = await createReviewing(pur, mgr, 'WH-A2V');
    const t = await api<{ transferOrderId: string }>('POST', '/api/inventory/transfer', {
      token: mgr, body: { confirmDrafts: true, toWarehouseId: 'WH-DAL', lines: [{ id: lineId, qty: 4 }] } });
    expect(t.status).toBe(200);
    const to = t.body.transferOrderId;
    // The PO itself still names WH-A2V; delete reassigns it to NULL.
    const del = await api('DELETE', '/api/warehouses/WH-A2V', { token: mgr });
    expect(del.status).toBe(200);
    const ev = await db`SELECT detail->>'from' AS f FROM inventory_events WHERE order_line_id = ${lineId} AND kind = 'transferred'`;
    expect(ev[0].f).toBe('WH-A2V');
    const r = await api('DELETE', `/api/inventory/transfer-orders/${to}`, { token: mgr });
    expect(r.status).toBe(500);                       // FK violation on order_lines.warehouse_id
    expect((await lineRow(lineId)).status).toBe('In Transit');
    // Receive remains a way out.
    expect((await api('POST', `/api/inventory/transfer-orders/${to}/receive`, { token: mgr })).status).toBe(200);
  });

  it('A2-03: the archive confirm removes a line from a Shipped SO the first 409 never named', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: a } = await loginAs(ALEX);
    const { token: b } = await loginAs(SOFIA);
    const { id } = await createReviewing(pur, a);
    // Second lot on the same PO, so SO-1 and SO-2 name different lines.
    const got = await api<Detail>('GET', `/api/orders/${id}`, { token: a });
    const l1 = got.body.order.lines[0].id;
    const so1 = await createSellOrderOn(a, l1, PN, 1);   // Draft
    const first = await api<{ sellOrders: { id: string }[] }>('POST', `/api/orders/${id}/archive`, { token: a });
    expect(first.status).toBe(409);
    expect(first.body.sellOrders.map(s => s.id)).toEqual([so1]);

    // Manager B, meanwhile: a new SO on the same lot, shipped.
    const so2 = await createSellOrderOn(b, l1, PN, 1);
    expect((await api('POST', `/api/sell-orders/${so2}/status`, { token: b, body: { to: 'Shipped' } })).status).toBe(200);

    const confirm = await api('POST', `/api/orders/${id}/archive`, { token: a, body: { removeFromSellOrders: true } });
    expect(confirm.status).toBe(200);
    const left = await getTestDb()`SELECT COUNT(*)::int AS n FROM sell_order_lines WHERE sell_order_id = ${so2}`;
    expect(left[0].n).toBe(0);                         // shipped SO-2 silently lost its line
    const st = await getTestDb()`SELECT status FROM sell_orders WHERE id = ${so2}`;
    expect(st[0].status).toBe('Shipped');
  });
});
