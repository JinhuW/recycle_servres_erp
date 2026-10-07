import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';

// Which manager paid the purchaser their commission: PUT /commission-paid-by,
// manager-only, open on a closed book (that is when the commission is paid),
// an active manager or null, and one name-carrying meta_changed per change.

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [{ category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40 }],
};

type PaidBy = { id: string; name: string } | null;
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
    expect(set.body.commissionPaidBy).toEqual({ id: sofia.user.id, name: sofiaName });
    expect(await paidByOf(marcus.token, id)).toEqual({ id: sofia.user.id, name: sofiaName });

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
    expect(await paidByOf(alex.token, id)).toEqual({ id: sofia.user.id, name: await nameOf(sofia.user.id) });
  });

  it('404s an unknown order', async () => {
    const { token } = await loginAs(ALEX);
    const sofia = await loginAs(SOFIA);
    expect((await setPaidBy(token, 'PO-999999', { userId: sofia.user.id })).status).toBe(404);
  });
});
