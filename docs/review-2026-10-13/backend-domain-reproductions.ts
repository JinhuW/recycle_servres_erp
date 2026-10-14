/**
 * Review evidence only: these nine tests assert observed defective behavior.
 * Verified together on isolated PostgreSQL 18: 9 passed, 21.01 seconds.
 * No application fix is included. Do not add this file to the normal test suite.
 *
 * Replay from the repository root against an explicitly isolated local database:
 *   cp docs/review-2026-10-13/backend-domain-reproductions.ts apps/backend/tests/review-domain-repro.test.ts
 *   cd apps/backend
 *   TEST_DATABASE_URL=<isolated-local-test-url> VITEST_MAX_FORKS=1 pnpm exec vitest run tests/review-domain-repro.test.ts
 *   rm tests/review-domain-repro.test.ts
 *
 * The relative imports below intentionally assume the temporary backend/tests
 * location. The repository test harness migrates/seeds worker-isolated DBs.
 * Never point this reproduction suite at a production database.
 */

import { it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { ALEX, MARCUS, PRIYA, loginAs } from './helpers/auth';
import { firstCustomerId, createSellOrderOn, signOffAll } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';
import { diffSellOrderLines, type SOLineSnap } from '../src/services/sellOrderLineMatch';
import { archiveOrderLinesTx } from '../src/services/orderAdvance';

beforeEach(resetDb);

async function waitBlocked(fragment: string, count = 1) {
  const db = getTestDb();
  for (let i = 0; i < 100; i++) {
    const [r] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE ${'%' + fragment + '%'} AND pid <> pg_backend_pid()`;
    if (r.n >= count) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Expected blocked statement not observed: ' + fragment);
}

it('reproduction: a manual-only completed sale disappears from dashboard revenue', async () => {
  const db = getTestDb();
  await db`DELETE FROM sell_order_lines`;
  await db`DELETE FROM sell_orders`;
  const { token } = await loginAs(ALEX);
  const made = await api<{ id: string }>('POST', '/api/sell-orders', { token, body: {
    customerId: await firstCustomerId(token),
    lines: [{ category: 'Other', label: 'Rails', qty: 2, unitPrice: 50 }],
  } });
  expect(made.status).toBe(201);
  await db`UPDATE sell_orders SET status = 'Done', done_at = NOW() WHERE id = ${made.body.id}`;
  const dash = await api<{ kpis: { revenue: number; count: number } }>('GET', '/api/dashboard?range=30d', { token });
  expect(dash.status).toBe(200);
  expect(dash.body.kpis.revenue).toBe(0);
  expect(dash.body.kpis.count).toBe(0);
});

it('reproduction: transfer reopen sees claims from before its inventory lock wait', async () => {
  const db = getTestDb();
  const { token } = await loginAs(ALEX);
  const line = await freeSellableLine(token, 2);
  const so = await createSellOrderOn(token, line.id, 'REVIEW-SNAPSHOT', 1);
  await db`INSERT INTO transfer_orders (id, status, to_warehouse_id)
    VALUES ('TO-REVIEW-SNAPSHOT', 'Received', (SELECT id FROM warehouses LIMIT 1))`;
  await db`UPDATE order_lines SET transfer_order_id = 'TO-REVIEW-SNAPSHOT' WHERE id = ${line.id}`;
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const gate = new Promise<void>(r => { release = r; });
  const promote = db.begin(async tx => {
    await tx`SELECT id FROM order_lines WHERE id = ${line.id} FOR UPDATE`;
    locked();
    await gate;
    await tx`UPDATE sell_orders SET status = 'Shipped' WHERE id = ${so}`;
  });
  await ready;
  const reopen = api('POST', '/api/inventory/transfer-orders/TO-REVIEW-SNAPSHOT/reopen', { token });
  await waitBlocked('sell_count');
  release();
  await promote;
  expect((await reopen).status).toBe(200);
  const [row] = await db`SELECT status FROM order_lines WHERE id = ${line.id}`;
  expect(row.status).toBe('In Transit');
  const [claim] = await db`SELECT status FROM sell_orders WHERE id = ${so}`;
  expect(claim.status).toBe('Shipped');
});

it('reproduction: two concurrent manual pairs leave an orphan pair', async () => {
  const db = getTestDb();
  const { token } = await loginAs(ALEX);
  const [acct] = await db`INSERT INTO bank_accounts (source, external_id) VALUES ('mercury', 'review') RETURNING id`;
  const ids: string[] = [];
  for (const [i, source] of ['mercury', 'paypal', 'paypal'].entries()) {
    const [r] = await db`INSERT INTO bank_transactions (source, external_id, account_id, posted_at, amount, raw)
      VALUES (${source}, ${'review-' + i}, ${acct.id}, NOW(), -100, '{}') RETURNING id`;
    ids.push(r.id);
  }
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const gate = new Promise<void>(r => { release = r; });
  const holder = db.begin(async tx => {
    await tx`SELECT id FROM bank_transactions WHERE id = ${ids[0]} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  const one = api('POST', `/api/bank-transactions/${ids[0]}/pair`, { token, body: { otherId: ids[1] } });
  const two = api('POST', `/api/bank-transactions/${ids[0]}/pair`, { token, body: { otherId: ids[2] } });
  await waitBlocked('UPDATE bank_transactions SET pair_id', 2);
  release();
  await holder;
  expect((await one).status).toBe(200);
  expect((await two).status).toBe(200);
  const groups = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM bank_transactions
    WHERE id = ANY(${ids}::uuid[]) GROUP BY pair_id ORDER BY n`;
  expect(groups.map(r => r.n)).toEqual([1, 2]);
});

it('reproduction: duplicated inventory lots lose audit edits to the first occurrence', () => {
  const snap: SOLineSnap = { inventory_id: 'same-lot', category: 'RAM', label: 'x',
    sub_label: null, part_number: 'PN', condition: null, warehouse_id: null,
    qty: 1, unit_price: 10 };
  const before = [snap, { ...snap, qty: 2 }];
  const after = [{ ...snap, qty: 10 }, { ...snap, qty: 2 }];
  expect(diffSellOrderLines(before, after)).toEqual({ added: [], removed: [], edited: [] });
});

it('reproduction: previous PO owner still writes after ownership changes while PATCH waits', async () => {
  const db = getTestDb();
  const { token, user } = await loginAs(MARCUS);
  const made = await api<{ id: string }>('POST', '/api/orders/draft', { token });
  expect(made.status).toBe(201);
  const [next] = await db`SELECT id FROM users WHERE email = ${PRIYA}`;
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const gate = new Promise<void>(r => { release = r; });
  const holder = db.begin(async tx => {
    await tx`SELECT id FROM orders WHERE id = ${made.body.id} FOR NO KEY UPDATE`;
    locked();
    await gate;
    await tx`UPDATE orders SET user_id = ${next.id} WHERE id = ${made.body.id}`;
  });
  await ready;
  const patch = api('PATCH', `/api/orders/${made.body.id}`, { token, body: { notes: 'previous-owner-write' } });
  await waitBlocked('LEFT JOIN suppliers sup');
  release();
  await holder;
  expect((await patch).status).toBe(200);
  const [row] = await db`SELECT user_id, notes FROM orders WHERE id = ${made.body.id}`;
  expect(row.user_id).not.toBe(user.id);
  expect(row.notes).toBe('previous-owner-write');
});

it('reproduction: concurrent link and ignore produce a linked ignored payment', async () => {
  const db = getTestDb();
  const { token } = await loginAs(ALEX);
  const made = await api<{ id: string }>('POST', '/api/orders/draft', { token });
  const [acct] = await db`INSERT INTO bank_accounts (source, external_id) VALUES ('mercury', 'review') RETURNING id`;
  const [leg] = await db`INSERT INTO bank_transactions (source, external_id, account_id, posted_at, amount, raw)
    VALUES ('mercury', 'review-link-ignore', ${acct.id}, NOW(), -100, '{}') RETURNING id`;
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const gate = new Promise<void>(r => { release = r; });
  const holder = db.begin(async tx => {
    await tx`SELECT id FROM bank_transactions WHERE id = ${leg.id} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  const link = api('POST', `/api/bank-transactions/${leg.id}/link`, { token, body: { orderId: made.body.id } });
  const ignore = api('POST', `/api/bank-transactions/${leg.id}/ignore`, { token });
  await waitBlocked('UPDATE bank_transactions', 2);
  release();
  await holder;
  expect((await link).status).toBe(200);
  expect((await ignore).status).toBe(200);
  const [row] = await db`SELECT order_id, ignored FROM bank_transactions WHERE id = ${leg.id}`;
  expect(row.order_id).toBe(made.body.id);
  expect(row.ignored).toBe(true);
});

it('reproduction: PO archive and sell-order Done take header locks in opposite order', async () => {
  const db = getTestDb();
  const { token, user } = await loginAs(ALEX);
  const line = await freeSellableLine(token, 2);
  const [parent] = await db`SELECT order_id FROM order_lines WHERE id = ${line.id}`;
  const so = await createSellOrderOn(token, line.id, 'REVIEW-DEADLOCK', 1);
  await db`UPDATE sell_orders SET status = 'Shipped' WHERE id = ${so}`;
  await signOffAll(so);
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const gate = new Promise<void>(r => { release = r; });
  const archive = db.begin(async tx => {
    await tx`SELECT id FROM orders WHERE id = ${parent.order_id} FOR NO KEY UPDATE`;
    locked();
    await gate;
    return archiveOrderLinesTx(tx, parent.order_id, { id: user.id, name: 'Alex', role: 'manager' }, { removeFromSellOrders: false });
  }).catch((e: { code?: string }) => ({ error: e.code }));
  await ready;
  const done = api('POST', `/api/sell-orders/${so}/status`, { token, body: { to: 'Done' } });
  await waitBlocked('SELECT id FROM orders WHERE id = ANY');
  release();
  const [a, d] = await Promise.all([archive, done]);
  expect(('error' in a && a.error === '40P01') || d.status === 500).toBe(true);
});

it('reproduction: create accepts invalid category margin and customer email rejected by patch', async () => {
  const { token } = await loginAs(ALEX);
  const category = await api('POST', '/api/categories', { token, body: { id: 'Review-invalid', label: 'Review', defaultMargin: -1 } });
  expect(category.status).toBe(201);
  expect((await api('PATCH', '/api/categories/Review-invalid', { token, body: { defaultMargin: -1 } })).status).toBe(400);
  const customer = await api<{ id: string }>('POST', '/api/customers', { token, body: { name: 'Review', contactEmail: 'not-an-email' } });
  expect(customer.status).toBe(201);
  expect((await api('PATCH', `/api/customers/${customer.body.id}`, { token, body: { contactEmail: 'not-an-email' } })).status).toBe(400);
});

it('reproduction: concurrent item-type renames leave purchase lines with the old intermediate name', async () => {
  const db = getTestDb();
  const { token } = await loginAs(ALEX);
  const [type] = await db`INSERT INTO item_types (name) VALUES ('Review old') RETURNING id`;
  const [line] = await db`SELECT id FROM order_lines LIMIT 1`;
  await db`UPDATE order_lines SET item_type = 'Review old' WHERE id = ${line.id}`;
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const gate = new Promise<void>(r => { release = r; });
  const holder = db.begin(async tx => {
    await tx`SELECT id FROM item_types WHERE id = ${type.id} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  const one = api('PATCH', `/api/item-types/${type.id}`, { token, body: { name: 'Review first' } });
  const two = api('PATCH', `/api/item-types/${type.id}`, { token, body: { name: 'Review second' } });
  await waitBlocked('UPDATE item_types', 2);
  release();
  await holder;
  expect((await one).status).toBe(200);
  expect((await two).status).toBe(200);
  const [actual] = await db`SELECT l.item_type, t.name FROM order_lines l, item_types t WHERE l.id = ${line.id} AND t.id = ${type.id}`;
  expect(actual.item_type).not.toBe(actual.name);
});
