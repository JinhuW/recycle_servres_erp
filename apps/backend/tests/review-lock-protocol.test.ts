import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { ALEX, MARCUS, PRIYA, loginAs } from './helpers/auth';
import { createSellOrderOn, signOffAll } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';
import { archiveOrderLinesTx } from '../src/services/orderAdvance';

// Writers that judged an unlocked read and then wrote: a rival between the
// read and the write left a pair with an orphan leg, a payment both linked
// and ignored, a transfer reopened over a committed sale, a PO edited by its
// previous owner, a rename that swept nothing, a client written by the
// purchaser it had just been taken from, and archive against Done in
// deadlock. Each case here holds a row lock to line two writers up, lets
// them go, and expects one winner and one explicit refusal — or, for the
// lock-order pair, no 40P01 at all.

beforeEach(resetDb);

// Waits until `count` connections of this database are blocked on a lock in a
// statement containing `fragment`.
async function waitBlocked(fragment: string, count = 1): Promise<void> {
  const db = getTestDb();
  for (let i = 0; i < 200; i++) {
    const [r] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE ${'%' + fragment + '%'} AND pid <> pg_backend_pid()`;
    if (r.n >= count) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('expected blocked statement not observed: ' + fragment);
}

type Tx = Parameters<Parameters<ReturnType<typeof getTestDb>['begin']>[0]>[0];

// A transaction that holds `lock` open until `release()`, then runs `during`
// (the rival's write, under the same lock) before it commits.
function holder(lock: (tx: Tx) => Promise<void>, during: (tx: Tx) => Promise<void> = async () => {}) {
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((r) => { locked = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const done = getTestDb().begin(async (tx) => {
    await lock(tx);
    locked();
    await gate;
    await during(tx);
  });
  return { ready, release, done };
}

async function bankLegs(sources: string[], amount = -100): Promise<string[]> {
  const db = getTestDb();
  const [acct] = await db<{ id: string }[]>`
    INSERT INTO bank_accounts (source, external_id) VALUES ('mercury', 'review') RETURNING id`;
  const ids: string[] = [];
  for (const [i, source] of sources.entries()) {
    const [r] = await db<{ id: string }[]>`
      INSERT INTO bank_transactions (source, external_id, account_id, posted_at, amount, raw)
      VALUES (${source}, ${'review-' + i}, ${acct.id}, NOW(), ${amount}, '{}') RETURNING id`;
    ids.push(r.id);
  }
  return ids;
}

describe('payments: the legs are locked before they are judged', () => {
  it('two pairs of one Mercury leg: one wins, the other is refused, no orphan', async () => {
    const db = getTestDb();
    const { token } = await loginAs(ALEX);
    const ids = await bankLegs(['mercury', 'paypal', 'paypal']);
    const h = holder(async (tx) => { await tx`SELECT id FROM bank_transactions WHERE id = ${ids[0]} FOR UPDATE`; });
    await h.ready;
    const one = api('POST', `/api/bank-transactions/${ids[0]}/pair`, { token, body: { otherId: ids[1] } });
    const two = api('POST', `/api/bank-transactions/${ids[0]}/pair`, { token, body: { otherId: ids[2] } });
    await waitBlocked('pair_id IN (SELECT pair_id FROM bank_transactions', 2);
    h.release();
    await h.done;
    expect([(await one).status, (await two).status].sort()).toEqual([200, 400]);
    const groups = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM bank_transactions
      WHERE id = ANY(${ids}::uuid[]) GROUP BY pair_id ORDER BY n`;
    expect(groups.map((r) => r.n)).toEqual([1, 2]);
    const [lone] = await db<{ pair_id: string | null }[]>`
      SELECT pair_id FROM bank_transactions WHERE id = ANY(${ids}::uuid[]) AND pair_id IS NULL`;
    expect(lone.pair_id).toBeNull();
  });

  it('link against ignore: one verdict stands, never both', async () => {
    const db = getTestDb();
    const { token } = await loginAs(ALEX);
    const made = await api<{ id: string }>('POST', '/api/orders/draft', { token });
    const [leg] = await bankLegs(['mercury']);
    const h = holder(async (tx) => { await tx`SELECT id FROM bank_transactions WHERE id = ${leg} FOR UPDATE`; });
    await h.ready;
    const link = api('POST', `/api/bank-transactions/${leg}/link`, { token, body: { orderId: made.body.id } });
    const ignore = api('POST', `/api/bank-transactions/${leg}/ignore`, { token });
    await waitBlocked('pair_id IN (SELECT pair_id FROM bank_transactions', 2);
    h.release();
    await h.done;
    expect([(await link).status, (await ignore).status].sort()).toEqual([200, 400]);
    const [row] = await db<{ order_id: string | null; ignored: boolean }[]>`
      SELECT order_id, ignored FROM bank_transactions WHERE id = ${leg}`;
    expect(row.order_id !== null && row.ignored).toBe(false);
  });

  it('a leg filed under two internal transactions at once belongs to one', async () => {
    const db = getTestDb();
    const { token } = await loginAs(ALEX);
    const [leg] = await bankLegs(['mercury']);
    const recA = await api<{ id: string }>('POST', '/api/internal-transactions', { token, body: { title: 'A' } });
    const recB = await api<{ id: string }>('POST', '/api/internal-transactions', { token, body: { title: 'B' } });
    const h = holder(async (tx) => { await tx`SELECT id FROM bank_transactions WHERE id = ${leg} FOR UPDATE`; });
    await h.ready;
    const a = api('POST', `/api/internal-transactions/${recA.body.id}/members`, { token, body: { txnIds: [leg] } });
    const b = api('POST', `/api/internal-transactions/${recB.body.id}/members`, { token, body: { txnIds: [leg] } });
    await waitBlocked('pair_id IN (SELECT pair_id FROM bank_transactions', 2);
    h.release();
    await h.done;
    expect([(await a).status, (await b).status].sort()).toEqual([200, 400]);
    const [row] = await db<{ internal_txn_id: string | null }[]>`
      SELECT internal_txn_id FROM bank_transactions WHERE id = ${leg}`;
    expect([recA.body.id, recB.body.id]).toContain(row.internal_txn_id);
  });
});

describe('inventory: claims are read after the lock', () => {
  it('transfer reopen under a sale that commits while it waits is refused', async () => {
    const db = getTestDb();
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);
    const so = await createSellOrderOn(token, line.id, 'REVIEW-SNAPSHOT', 1);
    await db`INSERT INTO transfer_orders (id, status, to_warehouse_id)
      VALUES ('TO-REVIEW-SNAPSHOT', 'Received', (SELECT id FROM warehouses LIMIT 1))`;
    await db`UPDATE order_lines SET transfer_order_id = 'TO-REVIEW-SNAPSHOT' WHERE id = ${line.id}`;
    const [before] = await db<{ status: string }[]>`SELECT status FROM order_lines WHERE id = ${line.id}`;
    const h = holder(async (tx) => { await tx`SELECT id FROM order_lines WHERE id = ${line.id} FOR UPDATE`; });
    await h.ready;
    const reopen = api('POST', '/api/inventory/transfer-orders/TO-REVIEW-SNAPSHOT/reopen', { token });
    await waitBlocked('transfer_order_id');
    // The sale commits while reopen waits on the line.
    await db`UPDATE sell_orders SET status = 'Shipped' WHERE id = ${so}`;
    h.release();
    await h.done;
    expect((await reopen).status).toBe(409);
    const [row] = await db<{ status: string }[]>`SELECT status FROM order_lines WHERE id = ${line.id}`;
    expect(row.status).toBe(before.status);
  });
});

describe('PO ownership is judged under the order lock', () => {
  it("the previous owner's PATCH after a hand-off is forbidden", async () => {
    const db = getTestDb();
    const { token } = await loginAs(MARCUS);
    const made = await api<{ id: string }>('POST', '/api/orders/draft', { token });
    expect(made.status).toBe(201);
    const [next] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${PRIYA}`;
    const h = holder(
      async (tx) => { await tx`SELECT id FROM orders WHERE id = ${made.body.id} FOR NO KEY UPDATE`; },
      async (tx) => { await tx`UPDATE orders SET user_id = ${next.id} WHERE id = ${made.body.id}`; },
    );
    await h.ready;
    const patch = api('PATCH', `/api/orders/${made.body.id}`, { token, body: { notes: 'previous-owner-write' } });
    await waitBlocked('LEFT JOIN suppliers sup');
    h.release();
    await h.done;
    expect((await patch).status).toBe(403);
    const [row] = await db<{ notes: string | null }[]>`SELECT notes FROM orders WHERE id = ${made.body.id}`;
    expect(row.notes).toBeNull();
  });

  it("the previous owner's line edit after a hand-off is forbidden", async () => {
    const db = getTestDb();
    const { token } = await loginAs(MARCUS);
    const made = await api<{ id: string }>('POST', '/api/orders/draft', { token });
    const added = await api<{ lines: { id: string }[] }>('PATCH', `/api/orders/${made.body.id}`, {
      token, body: { addLines: [{ category: 'RAM', label: 'x', qty: 1, unitCost: 1 }] },
    });
    expect(added.status).toBe(200);
    const [line] = await db<{ id: string }[]>`SELECT id FROM order_lines WHERE order_id = ${made.body.id}`;
    const [next] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${PRIYA}`;
    const h = holder(
      async (tx) => { await tx`SELECT id FROM orders WHERE id = ${made.body.id} FOR NO KEY UPDATE`; },
      async (tx) => { await tx`UPDATE orders SET user_id = ${next.id} WHERE id = ${made.body.id}`; },
    );
    await h.ready;
    const patch = api('PATCH', `/api/inventory/${line.id}`, { token, body: { label: 'renamed' } });
    await waitBlocked('FROM orders WHERE id = ANY');
    h.release();
    await h.done;
    expect((await patch).status).toBe(403);
  });
});

describe('one header lock order', () => {
  it('PO archive against sell-order Done never deadlocks', async () => {
    const db = getTestDb();
    const { token, user } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);
    const [parent] = await db<{ order_id: string }[]>`SELECT order_id FROM order_lines WHERE id = ${line.id}`;
    const so = await createSellOrderOn(token, line.id, 'REVIEW-DEADLOCK', 1);
    await db`UPDATE sell_orders SET status = 'Shipped' WHERE id = ${so}`;
    await signOffAll(so);
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const archive = db.begin(async (tx) => {
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
    expect('error' in a ? a.error : null).not.toBe('40P01');
    expect(d.status).not.toBe(500);
  });
});

describe('item types: the old name is read under the lock', () => {
  it('two renames leave every line on the final name', async () => {
    const db = getTestDb();
    const { token } = await loginAs(ALEX);
    const [type] = await db<{ id: string }[]>`INSERT INTO item_types (name) VALUES ('Review old') RETURNING id`;
    const [line] = await db<{ id: string }[]>`SELECT id FROM order_lines LIMIT 1`;
    await db`UPDATE order_lines SET item_type = 'Review old' WHERE id = ${line.id}`;
    const h = holder(async (tx) => { await tx`SELECT id FROM item_types WHERE id = ${type.id} FOR UPDATE`; });
    await h.ready;
    const one = api('PATCH', `/api/item-types/${type.id}`, { token, body: { name: 'Review first' } });
    const two = api('PATCH', `/api/item-types/${type.id}`, { token, body: { name: 'Review second' } });
    await waitBlocked('FROM item_types WHERE id', 2);
    h.release();
    await h.done;
    expect((await one).status).toBe(200);
    expect((await two).status).toBe(200);
    const [actual] = await db<{ item_type: string; name: string }[]>`
      SELECT l.item_type, t.name FROM order_lines l, item_types t WHERE l.id = ${line.id} AND t.id = ${type.id}`;
    expect(actual.item_type).toBe(actual.name);
  });
});

describe('clients: ownership is judged under the row lock', () => {
  it("the previous owner's PATCH after a reassign is forbidden", async () => {
    const db = getTestDb();
    const { token } = await loginAs(MARCUS);
    const made = await api<{ id: string }>('POST', '/api/suppliers', { token, body: { name: 'Review Client' } });
    expect(made.status).toBe(201);
    const [next] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${PRIYA}`;
    const h = holder(
      async (tx) => { await tx`SELECT id FROM suppliers WHERE id = ${made.body.id} FOR NO KEY UPDATE`; },
      async (tx) => { await tx`UPDATE suppliers SET owner_id = ${next.id} WHERE id = ${made.body.id}`; },
    );
    await h.ready;
    const patch = api('PATCH', `/api/suppliers/${made.body.id}`, { token, body: { company: 'taken' } });
    await waitBlocked('FROM suppliers WHERE id');
    h.release();
    await h.done;
    expect((await patch).status).toBe(403);
    const [row] = await db<{ company: string | null }[]>`SELECT company FROM suppliers WHERE id = ${made.body.id}`;
    expect(row.company).toBeNull();
  });
});
