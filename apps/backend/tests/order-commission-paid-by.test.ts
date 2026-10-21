import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';
import { NOW, DAY, fakeProvider } from './helpers/bankProvider';
import { syncBankTransactions } from '../src/banktx/sync';

// Who paid the purchaser their commission: PUT /commission-paid-by,
// manager-only, open on a closed book (that is when the commission is paid),
// an active manager, the company or null, and one name-carrying meta_changed
// per change. A commission screenshot upload records its uploader when nobody
// is on file. A bank payment linked as the commission reads as the company.

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [{ category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40 }],
};

type PaidBy =
  | { kind: 'manager'; id: string; name: string }
  | { kind: 'company'; linked: boolean }
  | null;
type Change = { field: string; from: unknown; to: unknown };
type OrderEvent = { kind: string; detail: { changes?: Change[] } };

async function advance(token: string, id: string) {
  return api('POST', `/api/orders/${id}/advance`, { token, body: {} });
}

// A PO owned by Marcus, moved by Alex all the way to Done — a closed book.
async function doneOrder() {
  const marcus = await loginAs(MARCUS);
  const alex = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await advance(marcus.token, id)).status).toBe(200);   // → in_transit
  for (let i = 0; i < 3; i++) expect((await advance(alex.token, id)).status).toBe(200);   // → done
  return { id, marcus, alex };
}

function setPaidBy(token: string, id: string, body: unknown) {
  return api<{ commissionPaidBy?: PaidBy; error?: string }>(
    'PUT', `/api/orders/${id}/commission-paid-by`, { token, body });
}

async function paidByOf(token: string, id: string): Promise<PaidBy | undefined> {
  const r = await api<{ order: { lifecycle: string; commissionPaidBy?: PaidBy } }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order.commissionPaidBy;
}

async function listPaidByOf(token: string, id: string): Promise<PaidBy | undefined> {
  const r = await api<{ orders: { id: string; commissionPaidBy?: PaidBy }[] }>('GET', '/api/orders?limit=200', { token });
  expect(r.status).toBe(200);
  return r.body.orders.find(o => o.id === id)?.commissionPaidBy;
}

// One outgoing Mercury row, linked on the Payments page as the PO's commission.
async function linkCommission(token: string, id: string): Promise<string> {
  await syncBankTransactions(testEnv, [
    fakeProvider('mercury', [
      { externalId: 'm-commission', amount: -50, counterparty: 'Marcus', postedAt: new Date(NOW - DAY) },
    ]),
  ]);
  const [row] = await getTestDb()<{ id: string }[]>`SELECT id FROM bank_transactions WHERE external_id = 'm-commission'`;
  const r = await api('POST', `/api/bank-transactions/${row.id}/link`, { token, body: { orderId: id, kind: 'commission' } });
  expect(r.status).toBe(200);
  return row.id;
}

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'paid.png', { type: 'image/png' });

async function uploadShot(token: string, id: string): Promise<PaidBy | undefined> {
  const r = await multipart(`/api/orders/${id}/status-meta/Commission/attachments`, { file: PNG() }, { token });
  expect(r.status).toBe(200);
  return (r.body as { commissionPaidBy?: PaidBy }).commissionPaidBy;
}

async function nameOf(userId: string): Promise<string> {
  const [row] = await getTestDb()<{ name: string }[]>`SELECT name FROM users WHERE id = ${userId}`;
  return row.name;
}

async function paidByChanges(token: string, id: string): Promise<Change[]> {
  const r = await api<{ events: OrderEvent[] }>('GET', `/api/orders/${id}/events`, { token });
  expect(r.status).toBe(200);
  return r.body.events
    .filter(e => e.kind === 'meta_changed')
    .flatMap(e => e.detail.changes ?? [])
    .filter(ch => ch.field === 'commission_paid_by');
}

describe('Commission paid by', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager records it on a Done PO; the owner reads it and the timeline names both sides', async () => {
    const { id, marcus, alex } = await doneOrder();
    const sofia = await loginAs(SOFIA);
    const sofiaName = await nameOf(sofia.user.id);
    expect(await paidByOf(alex.token, id)).toBeNull();

    const set = await setPaidBy(alex.token, id, { userId: sofia.user.id });
    expect(set.status).toBe(200);
    expect(set.body.commissionPaidBy).toEqual({ kind: 'manager', id: sofia.user.id, name: sofiaName });
    expect(await paidByOf(marcus.token, id)).toEqual({ kind: 'manager', id: sofia.user.id, name: sofiaName });

    // The same manager again changes nothing and logs nothing.
    expect((await setPaidBy(alex.token, id, { userId: sofia.user.id })).status).toBe(200);

    const cleared = await setPaidBy(alex.token, id, { userId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.commissionPaidBy).toBeNull();
    expect(await paidByOf(alex.token, id)).toBeNull();

    expect(await paidByChanges(alex.token, id)).toEqual([
      { field: 'commission_paid_by', from: null, to: sofiaName },
      { field: 'commission_paid_by', from: sofiaName, to: null },
    ]);
  });

  it('is manager-only: the owner gets a 403 and nothing is written', async () => {
    const { id, marcus, alex } = await doneOrder();
    const r = await setPaidBy(marcus.token, id, { userId: alex.user.id });
    expect(r.status).toBe(403);
    expect(await paidByOf(alex.token, id)).toBeNull();
  });

  it('takes only an active manager, or null', async () => {
    const { id, marcus, alex } = await doneOrder();
    const sofia = await loginAs(SOFIA);

    expect((await setPaidBy(alex.token, id, {})).status).toBe(400);
    expect((await setPaidBy(alex.token, id, { userId: 42 })).status).toBe(400);
    expect((await setPaidBy(alex.token, id, { userId: 'not-a-uuid' })).status).toBe(400);
    expect((await setPaidBy(alex.token, id, { company: false })).status).toBe(400);
    // One payer at a time.
    expect((await setPaidBy(alex.token, id, { company: true, userId: sofia.user.id })).status).toBe(400);
    // A purchaser never handles the money.
    expect((await setPaidBy(alex.token, id, { userId: marcus.user.id })).status).toBe(400);

    await getTestDb()`UPDATE users SET active = FALSE WHERE id = ${sofia.user.id}`;
    expect((await setPaidBy(alex.token, id, { userId: sofia.user.id })).status).toBe(400);

    expect(await paidByOf(alex.token, id)).toBeNull();
    expect(await paidByChanges(alex.token, id)).toEqual([]);
  });

  it('keeps a recorded payer after they are deactivated', async () => {
    const { id, alex } = await doneOrder();
    const sofia = await loginAs(SOFIA);
    expect((await setPaidBy(alex.token, id, { userId: sofia.user.id })).status).toBe(200);
    await getTestDb()`UPDATE users SET active = FALSE WHERE id = ${sofia.user.id}`;
    expect(await paidByOf(alex.token, id)).toEqual({ kind: 'manager', id: sofia.user.id, name: await nameOf(sofia.user.id) });
  });

  it('records the company, a fixed option the managers do not include, and swaps it for a manager', async () => {
    const { id, marcus, alex } = await doneOrder();
    const sofia = await loginAs(SOFIA);
    const sofiaName = await nameOf(sofia.user.id);

    const set = await setPaidBy(alex.token, id, { company: true });
    expect(set.status).toBe(200);
    expect(set.body.commissionPaidBy).toEqual({ kind: 'company', linked: false });
    expect(await paidByOf(marcus.token, id)).toEqual({ kind: 'company', linked: false });
    expect(await listPaidByOf(marcus.token, id)).toEqual({ kind: 'company', linked: false });
    // The same pick again changes nothing and logs nothing.
    expect((await setPaidBy(alex.token, id, { company: true })).status).toBe(200);

    expect((await setPaidBy(alex.token, id, { userId: sofia.user.id })).status).toBe(200);
    const [row] = await getTestDb()<{ commission_paid_by: string | null; commission_paid_by_company: boolean }[]>`
      SELECT commission_paid_by, commission_paid_by_company FROM orders WHERE id = ${id}`;
    expect(row).toEqual({ commission_paid_by: sofia.user.id, commission_paid_by_company: false });

    expect(await paidByChanges(alex.token, id)).toEqual([
      { field: 'commission_paid_by', from: null, to: 'Company' },
      { field: 'commission_paid_by', from: 'Company', to: sofiaName },
    ]);
  });

  it('never stores the company and a manager together', async () => {
    const { id } = await doneOrder();
    const sofia = await loginAs(SOFIA);
    await expect(getTestDb()`
      UPDATE orders SET commission_paid_by = ${sofia.user.id}, commission_paid_by_company = TRUE WHERE id = ${id}
    `).rejects.toThrow(/orders_commission_paid_by_one/);
  });

  it('the PO list carries it beside the detail, for the owner too', async () => {
    const { id, marcus, alex } = await doneOrder();
    const sofia = await loginAs(SOFIA);
    expect(await listPaidByOf(alex.token, id)).toBeNull();
    expect((await setPaidBy(alex.token, id, { userId: sofia.user.id })).status).toBe(200);
    const expected = { kind: 'manager', id: sofia.user.id, name: await nameOf(sofia.user.id) };
    expect(await listPaidByOf(alex.token, id)).toEqual(expected);
    expect(await listPaidByOf(marcus.token, id)).toEqual(expected);
  });

  it('reads as the company while a live bank payment is linked as the commission', async () => {
    const { id, marcus, alex } = await doneOrder();
    const sofia = await loginAs(SOFIA);
    expect((await setPaidBy(alex.token, id, { userId: sofia.user.id })).status).toBe(200);

    const txn = await linkCommission(alex.token, id);
    const linked = { kind: 'company', linked: true };
    expect(await paidByOf(alex.token, id)).toEqual(linked);
    expect(await paidByOf(marcus.token, id)).toEqual(linked);
    expect(await listPaidByOf(alex.token, id)).toEqual(linked);

    // The bank says who paid, so a pick by hand waits for the unlink.
    const refused = await setPaidBy(alex.token, id, { userId: null });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Payments page/);

    // A reversed payment paid nothing: the hand pick shows again.
    const db = getTestDb();
    await db`UPDATE bank_transactions SET settle_status = 'reversed' WHERE id = ${txn}`;
    expect(await paidByOf(alex.token, id)).toMatchObject({ kind: 'manager', id: sofia.user.id });
    await db`UPDATE bank_transactions SET settle_status = 'settled' WHERE id = ${txn}`;

    // A cost link is the supplier's money, not the commission.
    await db`UPDATE bank_transactions SET link_kind = 'payment' WHERE id = ${txn}`;
    expect(await paidByOf(alex.token, id)).toMatchObject({ kind: 'manager', id: sofia.user.id });
    await db`UPDATE bank_transactions SET link_kind = 'commission' WHERE id = ${txn}`;

    expect((await api('POST', `/api/bank-transactions/${txn}/unlink`, { token: alex.token, body: {} })).status).toBe(200);
    expect(await paidByOf(alex.token, id)).toMatchObject({ kind: 'manager', id: sofia.user.id });
    expect(await paidByChanges(alex.token, id)).toHaveLength(1);
  });

  it('a commission screenshot upload records its uploader while nobody is on file', async () => {
    const { id, marcus, alex } = await doneOrder();
    const alexName = await nameOf(alex.user.id);
    const mine = { kind: 'manager', id: alex.user.id, name: alexName };

    expect(await uploadShot(alex.token, id)).toEqual(mine);
    expect(await paidByOf(marcus.token, id)).toEqual(mine);
    // A second screenshot from the same manager changes nothing.
    expect(await uploadShot(alex.token, id)).toEqual(mine);
    expect(await paidByChanges(alex.token, id)).toEqual([
      { field: 'commission_paid_by', from: null, to: alexName },
    ]);

    // Another bucket's upload never touches it.
    const sofia = await loginAs(SOFIA);
    const pay = await multipart(`/api/orders/${id}/status-meta/Payment/attachments`, { file: PNG() }, { token: sofia.token });
    expect(pay.status).toBe(200);
    expect('commissionPaidBy' in (pay.body as object)).toBe(false);
  });

  it('an upload over another payer, or the company, writes nothing and reports what is on file', async () => {
    const { id, alex } = await doneOrder();
    const sofia = await loginAs(SOFIA);
    const sofiaName = await nameOf(sofia.user.id);

    expect((await setPaidBy(sofia.token, id, { userId: sofia.user.id })).status).toBe(200);
    expect(await uploadShot(alex.token, id)).toEqual({ kind: 'manager', id: sofia.user.id, name: sofiaName });

    expect((await setPaidBy(sofia.token, id, { company: true })).status).toBe(200);
    expect(await uploadShot(alex.token, id)).toEqual({ kind: 'company', linked: false });

    // Taking it over is the page's confirmed PUT.
    expect((await setPaidBy(alex.token, id, { userId: alex.user.id })).status).toBe(200);
    expect(await paidByChanges(alex.token, id)).toEqual([
      { field: 'commission_paid_by', from: null, to: sofiaName },
      { field: 'commission_paid_by', from: sofiaName, to: 'Company' },
      { field: 'commission_paid_by', from: 'Company', to: await nameOf(alex.user.id) },
    ]);
  });

  it('an upload while a bank payment is linked as the commission writes nothing', async () => {
    const { id, alex } = await doneOrder();
    await linkCommission(alex.token, id);
    expect(await uploadShot(alex.token, id)).toEqual({ kind: 'company', linked: true });
    const [row] = await getTestDb()<{ commission_paid_by: string | null }[]>`
      SELECT commission_paid_by FROM orders WHERE id = ${id}`;
    expect(row.commission_paid_by).toBeNull();
    expect(await paidByChanges(alex.token, id)).toEqual([]);
  });

  it('404s an unknown order', async () => {
    const { token } = await loginAs(ALEX);
    const sofia = await loginAs(SOFIA);
    expect((await setPaidBy(token, 'PO-999999', { userId: sofia.user.id })).status).toBe(404);
  });
});

// Paid by now follows the screenshot, so orders that already carried one were
// filled in once from its uploader.
describe('migration 0189 backfills Paid by from the commission screenshot', () => {
  beforeEach(async () => { await resetDb(); });

  const run = async (file: string) => {
    const sqlText = readFileSync(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), 'utf8');
    await getTestDb().unsafe(sqlText);
  };
  const replay = () => run('0189_backfill_commission_paid_by.sql');
  // A screenshot as an older release stored it: no payer written beside it.
  const oldShot = async (id: string, by: string, minutesAgo: number) => {
    await getTestDb()`
      INSERT INTO order_status_attachments
        (order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by, uploaded_at)
      VALUES (${id}, 'Commission', 'paid.png', 4, 'image/png', ${'k-' + id + minutesAgo}, 'https://x/paid.png', ${by},
              NOW() - make_interval(mins => ${minutesAgo}))`;
  };

  it('fills the latest uploader where nobody is on file, and leaves every record alone', async () => {
    const empty = await doneOrder();
    const picked = await doneOrder();
    const company = await doneOrder();
    const bare = await doneOrder();
    const { alex, marcus } = empty;
    const sofia = await loginAs(SOFIA);

    await oldShot(empty.id, alex.user.id, 30);
    await oldShot(empty.id, sofia.user.id, 10);
    await oldShot(picked.id, sofia.user.id, 10);
    expect((await setPaidBy(alex.token, picked.id, { userId: alex.user.id })).status).toBe(200);
    await oldShot(company.id, sofia.user.id, 10);
    expect((await setPaidBy(alex.token, company.id, { company: true })).status).toBe(200);
    // A purchaser never wrote this bucket; a row naming one is not a payer.
    await oldShot(bare.id, marcus.user.id, 10);

    await replay();
    await replay();

    const sofiaName = await nameOf(sofia.user.id);
    expect(await paidByOf(alex.token, empty.id)).toEqual({ kind: 'manager', id: sofia.user.id, name: sofiaName });
    expect(await paidByOf(alex.token, picked.id)).toMatchObject({ kind: 'manager', id: alex.user.id });
    expect(await paidByOf(alex.token, company.id)).toEqual({ kind: 'company', linked: false });
    expect(await paidByOf(alex.token, bare.id)).toBeNull();

    expect(await paidByChanges(alex.token, empty.id)).toEqual([
      { field: 'commission_paid_by', from: null, to: sofiaName },
    ]);
    const [ev] = await getTestDb()<{ actor_id: string; detail: { backfilled?: boolean } }[]>`
      SELECT actor_id, detail FROM order_events
      WHERE order_id = ${empty.id} AND kind = 'meta_changed'`;
    expect(ev).toMatchObject({ actor_id: sofia.user.id, detail: { backfilled: true } });
  });

  it('0192 takes the guess back where a bank row pays the commission', async () => {
    const linked = await doneOrder();
    const unlinked = await doneOrder();
    const { alex } = linked;
    const sofia = await loginAs(SOFIA);
    await oldShot(linked.id, sofia.user.id, 10);
    await oldShot(unlinked.id, sofia.user.id, 10);
    await replay();
    await linkCommission(alex.token, linked.id);

    await run('0192_unbackfill_linked_commission_payer.sql');
    await run('0192_unbackfill_linked_commission_payer.sql');

    const [row] = await getTestDb()<{ commission_paid_by: string | null }[]>`
      SELECT commission_paid_by FROM orders WHERE id = ${linked.id}`;
    expect(row.commission_paid_by).toBeNull();
    const sofiaName = await nameOf(sofia.user.id);
    const changes = await paidByChanges(alex.token, linked.id);
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(expect.arrayContaining([
      { field: 'commission_paid_by', from: null, to: sofiaName },
      { field: 'commission_paid_by', from: sofiaName, to: null },
    ]));
    expect(await paidByOf(alex.token, unlinked.id)).toMatchObject({ kind: 'manager', id: sofia.user.id });
  });

  it('0192 keeps a payer someone has set by hand since the backfill', async () => {
    const order = await doneOrder();
    const { alex } = order;
    const sofia = await loginAs(SOFIA);
    await oldShot(order.id, sofia.user.id, 10);
    await replay();
    expect((await setPaidBy(alex.token, order.id, { userId: alex.user.id })).status).toBe(200);
    expect((await setPaidBy(alex.token, order.id, { userId: sofia.user.id })).status).toBe(200);
    await linkCommission(alex.token, order.id);

    await run('0192_unbackfill_linked_commission_payer.sql');

    const [row] = await getTestDb()<{ commission_paid_by: string | null }[]>`
      SELECT commission_paid_by FROM orders WHERE id = ${order.id}`;
    expect(row.commission_paid_by).toBe(sofia.user.id);
  });
});
