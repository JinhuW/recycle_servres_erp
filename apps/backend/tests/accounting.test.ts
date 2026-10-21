import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { createSellOrderOn } from './helpers/fixtures';
import { mockFrankfurter } from './helpers/fx';
import { NOW, DAY, fakeProvider } from './helpers/bankProvider';
import { syncBankTransactions } from '../src/banktx/sync';

// The managers' RMB book: manager-only, entries linked to the record they are
// for, totals in CNY at each dollar entry's own rate, a running balance that
// no filter can move, and the commission payer filled the way a screenshot
// upload fills it.

type Entry = {
  id: string; direction: string; kind: string; amount: number; currency: string; fxRate: number | null;
  amountCny: number; occurredOn: string; manager: { id: string; name: string };
  target: { type: string; id: string } | null; balance?: number | null;
  voided: { reason: string } | null;
};
type Summary = {
  opening: number; received: number; paid: number; closing: number;
  byKind: Record<string, { received: number; paid: number; count: number }>;
  managers: { id: string; name: string; balance: number }[];
  first: string | null; fx: { rate: number };
};
type PaidBy = { kind: 'manager'; id: string; name: string } | { kind: 'company'; linked: boolean } | null;

const PO_BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [{ category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40 }],
};

async function draftPO(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', { token, body: PO_BODY });
  expect(r.status).toBe(201);
  return r.body.id;
}

// Marcus's PO, moved by Alex to Done: its commission is owed and paid.
async function donePO(): Promise<string> {
  const marcus = await loginAs(MARCUS);
  const alex = await loginAs(ALEX);
  const id = await draftPO(marcus.token);
  expect((await api('POST', `/api/orders/${id}/advance`, { token: marcus.token, body: {} })).status).toBe(200);
  for (let i = 0; i < 3; i++) {
    expect((await api('POST', `/api/orders/${id}/advance`, { token: alex.token, body: {} })).status).toBe(200);
  }
  return id;
}

async function shippedSO(token: string): Promise<{ id: string; lineId: string }> {
  const line = await freeSellableLine(token, 1);
  const id = await createSellOrderOn(token, line.id, 'PN-1', 1, 90);
  expect((await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 'ship' } })).status).toBe(200);
  const got = await api<{ order: { lines: { id: string }[] } }>('GET', `/api/sell-orders/${id}`, { token });
  return { id, lineId: got.body.order.lines[0].id };
}

async function openCase(token: string, so: { id: string; lineId: string }): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/after-sales', {
    token, body: { sellOrderId: so.id, issue: 'dead stick', lines: [{ sellOrderLineId: so.lineId, qty: 1 }] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

function record(token: string, body: Record<string, unknown>) {
  return api<{ id: string; commissionPaidBy?: PaidBy; error?: string }>('POST', '/api/accounting/entries', { token, body });
}

async function recorded(token: string, body: Record<string, unknown>): Promise<string> {
  const r = await record(token, body);
  expect(r.status, r.body.error).toBe(201);
  return r.body.id;
}

const entryOf = async (token: string, id: string) =>
  (await api<{ entry: Entry & { events: { kind: string; detail: Record<string, unknown> }[] } }>(
    'GET', `/api/accounting/entries/${id}`, { token })).body.entry;

const listOf = async (token: string, query: string) =>
  (await api<{ rows: Entry[]; nextCursor: string | null }>('GET', `/api/accounting/entries?${query}`, { token })).body;

describe('accounting', () => {
  let alex: Awaited<ReturnType<typeof loginAs>>;
  // The fields every entry needs; each test names what it is for.
  let base: (over: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7.2, '2026-10-01');
    alex = await loginAs(ALEX);
    base = over => ({
      direction: 'out', kind: 'other', amount: 100, currency: 'CNY', method: 'alipay',
      occurredOn: '2026-10-05', managerId: alex.user.id, ...over,
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is manager-only', async () => {
    const { token: pur } = await loginAs(MARCUS);
    expect((await api('GET', '/api/accounting/summary?from=2026-10-01&to=2026-10-31', { token: pur })).status).toBe(403);
    expect((await api('GET', '/api/accounting/entries', { token: pur })).status).toBe(403);
    expect((await record(pur, base({}))).status).toBe(403);
    expect((await api('GET', '/api/accounting/entries', {})).status).toBe(401);
  });

  it('numbers entries AC-, and holds each kind to its record', async () => {
    const po = await draftPO(alex.token);
    const first = await recorded(alex.token, base({ kind: 'purchase', targetId: po }));
    expect(first).toMatch(/^AC-\d+$/);
    const second = await recorded(alex.token, base({}));
    expect(Number(second.slice(3))).toBe(Number(first.slice(3)) + 1);

    expect((await record(alex.token, base({ kind: 'purchase' }))).status).toBe(400);
    expect((await record(alex.token, base({ kind: 'other', targetId: po }))).status).toBe(400);
    expect((await record(alex.token, base({ kind: 'purchase', targetId: 'PO-999999' }))).status).toBe(404);
    expect((await record(alex.token, base({ kind: 'sale', direction: 'in', targetId: po }))).status).toBe(404);
    const { user: marcus } = await loginAs(MARCUS);
    expect((await record(alex.token, base({ managerId: marcus.id }))).status).toBe(400);
    expect((await record(alex.token, base({ occurredOn: '2099-01-01' }))).status).toBe(400);
    expect((await record(alex.token, base({ amount: 0 }))).status).toBe(400);
    expect((await record(alex.token, base({ method: 'paypal' }))).status).toBe(400);

    const got = await entryOf(alex.token, first);
    expect(got).toMatchObject({ kind: 'purchase', target: { type: 'po', id: po }, currency: 'CNY', fxRate: null, amountCny: 100 });
    expect(got.events.map(e => e.kind)).toEqual(['created']);
  });

  it('books dollars into RMB at the typed rate, or the FX ledger\'s', async () => {
    const typed = await recorded(alex.token, base({ currency: 'USD', amount: 100, fxRate: 7.1 }));
    const latest = await recorded(alex.token, base({ currency: 'USD', amount: 100 }));
    expect(await entryOf(alex.token, typed)).toMatchObject({ fxRate: 7.1, amountCny: 710 });
    expect(await entryOf(alex.token, latest)).toMatchObject({ fxRate: 7.2, amountCny: 720 });
    expect((await record(alex.token, base({ currency: 'USD', fxRate: 7100 }))).status).toBe(400);
  });

  it('states the period as opening + received − paid = closing, voided entries left out', async () => {
    const sofia = await loginAs(SOFIA);
    await recorded(alex.token, base({ direction: 'in', amount: 1000, occurredOn: '2026-09-20' }));
    await recorded(alex.token, base({ direction: 'out', amount: 300, occurredOn: '2026-10-02' }));
    await recorded(alex.token, base({ direction: 'in', amount: 500, occurredOn: '2026-10-10' }));
    await recorded(alex.token, base({ direction: 'out', amount: 80, occurredOn: '2026-10-11', managerId: sofia.user.id }));
    const voided = await recorded(alex.token, base({ direction: 'out', amount: 999, occurredOn: '2026-10-12' }));
    expect((await api('POST', `/api/accounting/entries/${voided}/void`, { token: alex.token, body: { reason: 'typo' } })).status).toBe(200);

    const all = (await api<Summary>('GET', '/api/accounting/summary?from=2026-10-01&to=2026-10-31', { token: alex.token })).body;
    expect(all).toMatchObject({ opening: 1000, received: 500, paid: 380, closing: 1120, first: '2026-09-20' });
    expect(all.byKind.other).toEqual({ received: 500, paid: 380, count: 3 });
    expect(all.managers.find(m => m.id === alex.user.id)?.balance).toBe(1200);
    expect(all.managers.find(m => m.id === sofia.user.id)?.balance).toBe(-80);
    expect(all.fx.rate).toBe(7.2);

    const mine = (await api<Summary>(
      'GET', `/api/accounting/summary?from=2026-10-01&to=2026-10-31&managerId=${alex.user.id}`, { token: alex.token })).body;
    expect(mine).toMatchObject({ opening: 1000, received: 500, paid: 300, closing: 1200 });

    expect((await api('GET', '/api/accounting/summary?from=2026-10-31&to=2026-10-01', { token: alex.token })).status).toBe(400);
  });

  it('runs the balance over the whole book, whatever the filters hide', async () => {
    const po = await draftPO(alex.token);
    await recorded(alex.token, base({ direction: 'in', amount: 1000, occurredOn: '2026-10-01' }));
    await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 300, occurredOn: '2026-10-02' }));
    await recorded(alex.token, base({ direction: 'in', amount: 50, occurredOn: '2026-10-03', counterparty: 'Acme' }));

    const book = await listOf(alex.token, 'from=2026-10-01&to=2026-10-31');
    expect(book.rows.map(r => [r.amount, r.balance])).toEqual([[50, 750], [300, 700], [1000, 1000]]);
    const purchases = await listOf(alex.token, 'kind=purchase');
    expect(purchases.rows.map(r => r.balance)).toEqual([700]);
    const searched = await listOf(alex.token, 'q=acme');
    expect(searched.rows.map(r => r.balance)).toEqual([750]);
    // A window that starts late still carries what came before it.
    const late = await listOf(alex.token, 'from=2026-10-03&to=2026-10-31');
    expect(late.rows.map(r => r.balance)).toEqual([750]);

    // Pages walk the same order without gaps.
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await listOf(alex.token, 'limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      seen.push(...page.rows.map(r => r.amount));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([50, 300, 1000]);
    // A mangled cursor is page one, not a 500.
    expect((await listOf(alex.token, 'cursor=not-a-cursor')).rows).toHaveLength(3);
  });

  it('shows each record its own side of the book', async () => {
    const po = await draftPO(alex.token);
    await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 500 }));
    await recorded(alex.token, base({ kind: 'purchase', targetId: po, direction: 'in', amount: 50 }));
    await recorded(alex.token, base({ kind: 'commission', targetId: po, amount: 70 }));
    const so = await shippedSO(alex.token);
    const asCase = await openCase(alex.token, so);
    await recorded(alex.token, base({ kind: 'sale', direction: 'in', targetId: so.id, amount: 640 }));
    await recorded(alex.token, base({ kind: 'after_sales', targetId: asCase, amount: 60 }));

    type Ledger = { entries: Entry[]; net: number; target: { id: string; amount: number; currency: string } };
    const cost = (await api<Ledger>('GET', `/api/accounting/by-order/${po}?kind=purchase`, { token: alex.token })).body;
    expect(cost.entries).toHaveLength(2);
    expect(cost.net).toBe(450);
    expect(cost.target).toMatchObject({ id: po, amount: 20, currency: 'USD' });
    const commission = (await api<Ledger>('GET', `/api/accounting/by-order/${po}?kind=commission`, { token: alex.token })).body;
    expect(commission.net).toBe(70);
    const sale = (await api<Ledger>('GET', `/api/accounting/by-sell-order/${so.id}`, { token: alex.token })).body;
    expect(sale.entries.map(e => e.kind).sort()).toEqual(['after_sales', 'sale']);
    expect(sale.net).toBe(580);
    const refund = (await api<Ledger>('GET', `/api/accounting/by-after-sales/${asCase}`, { token: alex.token })).body;
    expect(refund.net).toBe(60);

    const picked = await api<{ candidates: { id: string; recordedCny: number }[] }>(
      'GET', `/api/accounting/targets?kind=sale&q=${so.id}`, { token: alex.token });
    expect(picked.body.candidates).toEqual([expect.objectContaining({ id: so.id, recordedCny: 580 })]);
    expect((await api('GET', '/api/accounting/targets?kind=other', { token: alex.token })).status).toBe(400);
  });

  it('edits with a history, voids out of the book and restores', async () => {
    const id = await recorded(alex.token, base({ amount: 100 }));
    const edit = await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { amount: 120, note: 'fee' } });
    expect(edit.status).toBe(200);
    const edited = await entryOf(alex.token, id);
    expect(edited.amount).toBe(120);
    expect(edited.events.at(-1)).toMatchObject({
      kind: 'edited', detail: { changes: { amount: { from: 100, to: 120 }, note: { from: null, to: 'fee' } } },
    });
    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { kind: 'purchase' } })).status).toBe(400);

    expect((await api('POST', `/api/accounting/entries/${id}/void`, { token: alex.token, body: {} })).status).toBe(400);
    expect((await api('POST', `/api/accounting/entries/${id}/void`, { token: alex.token, body: { reason: 'dup' } })).status).toBe(200);
    expect((await api('POST', `/api/accounting/entries/${id}/void`, { token: alex.token, body: { reason: 'dup' } })).status).toBe(409);
    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { amount: 1 } })).status).toBe(409);
    expect((await listOf(alex.token, '')).rows).toHaveLength(0);
    const withVoided = await listOf(alex.token, 'voided=1');
    expect(withVoided.rows[0]).toMatchObject({ id, balance: null, voided: { reason: 'dup' } });

    expect((await api('POST', `/api/accounting/entries/${id}/restore`, { token: alex.token })).status).toBe(200);
    expect((await api('POST', `/api/accounting/entries/${id}/restore`, { token: alex.token })).status).toBe(409);
    expect((await entryOf(alex.token, id)).events.map(e => e.kind)).toEqual(['created', 'edited', 'voided', 'restored']);
  });

  it('a paid commission names its manager as the payer when nobody is on file', async () => {
    const sofia = await loginAs(SOFIA);
    const po = await donePO();
    const r = await record(alex.token, base({ kind: 'commission', targetId: po, managerId: sofia.user.id }));
    expect(r.status).toBe(201);
    expect(r.body.commissionPaidBy).toMatchObject({ kind: 'manager', id: sofia.user.id });

    // Someone is on file now: a second entry leaves them.
    const again = await record(alex.token, base({ kind: 'commission', targetId: po }));
    expect(again.body.commissionPaidBy).toBeUndefined();
    const order = await api<{ order: { commissionPaidBy: PaidBy } }>('GET', `/api/orders/${po}`, { token: alex.token });
    expect(order.body.order.commissionPaidBy).toMatchObject({ kind: 'manager', id: sofia.user.id });
    const events = await api<{ events: { kind: string; detail: { changes?: { field: string }[] } }[] }>(
      'GET', `/api/orders/${po}/events`, { token: alex.token });
    expect(events.body.events.filter(e => e.kind === 'meta_changed'
      && e.detail.changes?.some(ch => ch.field === 'commission_paid_by'))).toHaveLength(1);
  });

  it('fills the payer once, and moves it with a corrected manager while it is still theirs', async () => {
    const sofia = await loginAs(SOFIA);
    const po = await donePO();
    const payerOf = async () =>
      (await api<{ order: { commissionPaidBy: PaidBy } }>('GET', `/api/orders/${po}`, { token: alex.token })).body.order.commissionPaidBy;
    const patch = (id: string, body: Record<string, unknown>) =>
      api<{ commissionPaidBy?: PaidBy }>('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body });
    const id = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    expect(await payerOf()).toMatchObject({ kind: 'manager', id: alex.user.id });

    // Booked under the wrong manager: the correction carries the payer along.
    expect((await patch(id, { managerId: sofia.user.id })).body.commissionPaidBy)
      .toMatchObject({ kind: 'manager', id: sofia.user.id });
    expect(await payerOf()).toMatchObject({ kind: 'manager', id: sofia.user.id });

    // Cleared by hand on purpose, a later edit of the note leaves it cleared.
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: null } })).status).toBe(200);
    expect((await patch(id, { note: 'typo fixed' })).body.commissionPaidBy).toBeUndefined();
    expect((await patch(id, { managerId: alex.user.id })).body.commissionPaidBy).toBeUndefined();
    expect(await payerOf()).toBeNull();
  });

  it('leaves the payer alone when the company paid, or a bank row says so', async () => {
    const company = await donePO();
    expect((await api('PUT', `/api/orders/${company}/commission-paid-by`, { token: alex.token, body: { company: true } })).status).toBe(200);
    expect((await record(alex.token, base({ kind: 'commission', targetId: company }))).body.commissionPaidBy).toBeUndefined();

    const banked = await donePO();
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [{ externalId: 'm-commission', amount: -50, counterparty: 'Marcus', postedAt: new Date(NOW - DAY) }]),
    ]);
    const [row] = await getTestDb()<{ id: string }[]>`SELECT id FROM bank_transactions WHERE external_id = 'm-commission'`;
    expect((await api('POST', `/api/bank-transactions/${row.id}/link`, {
      token: alex.token, body: { orderId: banked, kind: 'commission' },
    })).status).toBe(200);
    expect((await record(alex.token, base({ kind: 'commission', targetId: banked }))).body.commissionPaidBy).toBeUndefined();
    const [o] = await getTestDb()<{ commission_paid_by: string | null }[]>`SELECT commission_paid_by FROM orders WHERE id = ${banked}`;
    expect(o.commission_paid_by).toBeNull();
  });

  it('keeps money booked on a deleted draft, and says which PO it was', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await draftPO(marcus.token);
    const id = await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 200 }));
    expect((await api('DELETE', `/api/orders/${po}`, { token: marcus.token })).status).toBe(200);

    const orphan = await entryOf(alex.token, id);
    expect(orphan.target).toBeNull();
    expect(orphan.events.at(-1)).toMatchObject({ kind: 'unlinked', detail: { orderId: po } });
    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { note: 'supplier kept it' } })).status).toBe(200);
    const summary = (await api<Summary>('GET', '/api/accounting/summary?from=2026-10-01&to=2026-10-31', { token: alex.token })).body;
    expect(summary.paid).toBe(200);
  });
});
