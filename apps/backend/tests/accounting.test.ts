import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS, PRIYA } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { createSellOrderOn, signOffAll } from './helpers/fixtures';
import { mockFrankfurter } from './helpers/fx';
import { NOW, DAY, fakeProvider } from './helpers/bankProvider';
import { syncBankTransactions } from '../src/banktx/sync';

// The RMB Flow: manager-only, entries linked to the record they are for,
// totals in CNY at each dollar entry's own rate, a running balance that no
// filter can move, and an entry's Paid by kept in step with its PO's payer
// both ways — a PO the Business Account paid has no live entry here.

type Entry = {
  id: string; direction: string; kind: string; amount: number; currency: string; fxRate: number | null;
  amountCny: number; occurredOn: string; method: string; counterparty: string | null;
  manager: { id: string; name: string };
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

// A company-paid draft by default; `{ payment: 'self' }` makes it the
// purchaser's own money, the one kind of cost the RMB Flow books.
async function draftPO(token: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', { token, body: { ...PO_BODY, ...over } });
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
    const po = await draftPO(alex.token, { payment: 'self' });
    const first = await recorded(alex.token, base({ kind: 'purchase', targetId: po }));
    expect(first).toMatch(/^AC-\d+$/);
    const second = await recorded(alex.token, base({}));
    expect(Number(second.slice(3))).toBe(Number(first.slice(3)) + 1);

    expect((await record(alex.token, base({ kind: 'purchase' }))).status).toBe(400);
    expect((await record(alex.token, base({ kind: 'other', targetId: po }))).status).toBe(400);
    expect((await record(alex.token, base({ kind: 'purchase', targetId: 'PO-999999' }))).status).toBe(404);
    expect((await record(alex.token, base({ managerId: 'nobody' }))).status).toBe(400);
    expect((await record(alex.token, base({ managerId: null }))).status).toBe(400);
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
    const sofia = await loginAs(SOFIA);
    const po = await draftPO(alex.token, { payment: 'self' });
    await recorded(alex.token, base({ direction: 'in', amount: 1000, occurredOn: '2026-10-01' }));
    await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 300, occurredOn: '2026-10-02', managerId: sofia.user.id }));
    await recorded(alex.token, base({ direction: 'in', amount: 50, occurredOn: '2026-10-03', counterparty: 'Acme' }));

    const book = await listOf(alex.token, 'from=2026-10-01&to=2026-10-31');
    expect(book.rows.map(r => [r.amount, r.balance])).toEqual([[50, 750], [300, 700], [1000, 1000]]);
    const purchases = await listOf(alex.token, 'kind=purchase');
    expect(purchases.rows.map(r => r.balance)).toEqual([700]);
    // One company-wide book: scoping to a payer hides rows, never moves the balance.
    const sofias = await listOf(alex.token, `managerId=${sofia.user.id}`);
    expect(sofias.rows.map(r => [r.amount, r.manager.id, r.balance])).toEqual([[300, sofia.user.id, 700]]);
    const alexs = await listOf(alex.token, `managerId=${alex.user.id}`);
    expect(alexs.rows.map(r => [r.amount, r.balance])).toEqual([[50, 750], [1000, 1000]]);
    expect((await api('GET', '/api/accounting/entries?managerId=business', { token: alex.token })).status).toBe(400);
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
    const po = await draftPO(alex.token, { payment: 'self' });
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

  // ── The two-way link with the PO (0199) ───────────────────────────────────

  const payerOf = async (po: string) =>
    (await api<{ order: { commissionPaidBy: PaidBy } }>('GET', `/api/orders/${po}`, { token: alex.token })).body.order.commissionPaidBy;
  const patch = (id: string, body: Record<string, unknown>) =>
    api<{ commissionPaidBy?: PaidBy; error?: string }>('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body });
  const managerOf = async (id: string) => (await entryOf(alex.token, id)).manager;
  const poEvents = async (po: string, field: string) =>
    (await api<{ events: { kind: string; detail: { changes?: { field: string; from: unknown; to: unknown }[] } }[] }>(
      'GET', `/api/orders/${po}/events`, { token: alex.token })).body.events
      .filter(e => e.kind === 'meta_changed' && e.detail.changes?.some(ch => ch.field === field));
  // A Mercury row, synced in; its id for the link routes.
  const bankRow = async (externalId: string) => {
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [{ externalId, amount: -50, counterparty: 'Marcus', postedAt: new Date(NOW - DAY) }]),
    ]);
    const [row] = await getTestDb()<{ id: string }[]>`SELECT id FROM bank_transactions WHERE external_id = ${externalId}`;
    return row.id;
  };

  it('a commission entry names the PO\'s payer, and the PO names the entry\'s', async () => {
    const sofia = await loginAs(SOFIA);
    const po = await donePO();
    const r = await record(alex.token, base({ kind: 'commission', targetId: po, managerId: sofia.user.id }));
    expect(r.status).toBe(201);
    expect(r.body.commissionPaidBy).toMatchObject({ kind: 'manager', id: sofia.user.id });
    expect(await payerOf(po)).toMatchObject({ kind: 'manager', id: sofia.user.id });

    // Booked under the wrong manager: the correction moves the PO's payer.
    expect((await patch(r.body.id, { managerId: alex.user.id })).body.commissionPaidBy)
      .toMatchObject({ kind: 'manager', id: alex.user.id });
    expect(await payerOf(po)).toMatchObject({ kind: 'manager', id: alex.user.id });
    // A note edit touches neither side.
    expect((await patch(r.body.id, { note: 'typo fixed' })).body.commissionPaidBy).toBeUndefined();
    expect(await poEvents(po, 'commission_paid_by')).toHaveLength(2);

    // The PO's side: set by hand, the entry follows, with its own history line.
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: sofia.user.id } })).status).toBe(200);
    expect(await managerOf(r.body.id)).toMatchObject({ id: sofia.user.id });
    expect((await entryOf(alex.token, r.body.id)).events.at(-1)).toMatchObject({
      kind: 'edited', detail: { synced: 'po', changes: { managerId: { from: alex.user.id, to: sofia.user.id } } },
    });
    // Cleared on the PO, nobody is on file: the entry keeps what it recorded.
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: null } })).status).toBe(200);
    expect(await managerOf(r.body.id)).toMatchObject({ id: sofia.user.id });
    expect(await payerOf(po)).toBeNull();
    // Two entries on one PO carry one payer: the PO's.
    const second = await recorded(alex.token, base({ kind: 'commission', targetId: po, managerId: alex.user.id }));
    expect(await managerOf(r.body.id)).toMatchObject({ id: alex.user.id });
    expect(await managerOf(second)).toMatchObject({ id: alex.user.id });
  });

  it('a Paid by that follows the PO clears a sign-off, and leaves an unsigned entry as it was', async () => {
    type Review = { state: string; version: string; author: { id: string } | null; by: { id: string } | null; query: { answer: unknown } | null };
    type Cleared = { reviewer: { id: string } | null; changes: Record<string, { from: unknown; to: unknown }> } | null;
    const sofia = await loginAs(SOFIA);
    const reviewed = async (id: string) =>
      (await api<{ entry: { manager: { id: string }; review: Review; events: { kind: string; detail: Record<string, unknown> }[] } }>(
        'GET', `/api/accounting/entries/${id}`, { token: alex.token })).body.entry;
    const signOff = async (id: string) => {
      const { review } = await reviewed(id);
      expect((await api('POST', `/api/accounting/entries/${id}/review`, { token: sofia.token, body: { version: review.version } })).status).toBe(200);
    };
    const clearedOf = async (id: string) =>
      (await api<{ rows: { id: string; cleared: Cleared }[] }>('GET', '/api/accounting/review?tab=mine', { token: sofia.token }))
        .body.rows.find(r => r.id === id)?.cleared;
    const po = await donePO();
    const signed = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    const open = await recorded(alex.token, base({ kind: 'commission', targetId: po, amount: 50 }));
    const asked = await recorded(alex.token, base({ kind: 'commission', targetId: po, amount: 20 }));
    await signOff(signed);
    expect((await api('POST', `/api/accounting/entries/${asked}/query`, { token: sofia.token, body: { text: 'which chat?' } })).status).toBe(200);

    // The PO page names Sofia: the sign-off Sofia gave Alex's payer is cleared.
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: sofia.user.id } })).status).toBe(200);
    const s = await reviewed(signed);
    expect(s.manager).toMatchObject({ id: sofia.user.id });
    expect(s.review).toMatchObject({ state: 'changed', by: null, author: { id: alex.user.id } });
    expect(s.events.at(-1)).toMatchObject({
      kind: 'edited',
      detail: { synced: 'po', changes: { managerId: { from: alex.user.id, to: sofia.user.id } }, clearedReview: { by: sofia.user.id } },
    });
    expect(await clearedOf(signed)).toMatchObject({
      reviewer: { id: sofia.user.id }, changes: { managerId: { from: alex.user.id, to: sofia.user.id } }, followedPo: true,
    });
    // Nothing signed, nothing to clear; a question stays open, unanswered.
    const o = await reviewed(open);
    expect(o.review).toMatchObject({ state: 'open' });
    expect(o.events.at(-1)?.detail).not.toHaveProperty('clearedReview');
    expect((await reviewed(asked)).review).toMatchObject({ state: 'queried', query: { answer: null } });

    // Another entry's Paid by writing back to the PO clears it the same way.
    await signOff(signed);
    expect((await patch(open, { managerId: alex.user.id })).status).toBe(200);
    expect((await reviewed(signed)).review).toMatchObject({ state: 'changed', by: null });
    expect((await reviewed(signed)).events.at(-1)).toMatchObject({
      detail: { synced: 'po', clearedReview: { by: sofia.user.id } },
    });
    // A manager's own edit since then is a person's change, not the PO's.
    expect((await patch(signed, { amount: 90 })).status).toBe(200);
    expect(await clearedOf(signed)).toMatchObject({ followedPo: false });
  });

  it('a PO the Business Account paid voids its RMB entries, and takes no new one', async () => {
    const po = await donePO();
    const id = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    expect(await payerOf(po)).toMatchObject({ kind: 'manager', id: alex.user.id });
    // Flagged company-paid on the PO: the entry leaves the RMB Flow, with the reason.
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { company: true } })).status).toBe(200);
    const gone = await entryOf(alex.token, id);
    expect(gone.voided).toMatchObject({ reason: 'Paid from the Business Account' });
    expect(gone.manager).toMatchObject({ id: alex.user.id });
    // The manager whose save voided it is the event's actor; nobody voided it by hand.
    expect(gone.events.at(-1)).toMatchObject({
      kind: 'voided', actor: { id: alex.user.id }, detail: { synced: 'po', reason: 'Paid from the Business Account' },
    });
    expect((await listOf(alex.token, '')).rows.map(r => r.id)).not.toContain(id);
    // Nothing new while the company paid; the flag is undone on the PO.
    const refused = await record(alex.token, base({ kind: 'commission', targetId: po }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/change that on the PO/);
    expect((await record(alex.token, base({ kind: 'commission', targetId: po, managerId: null }))).status).toBe(400);
    expect((await patch(id, { managerId: alex.user.id })).status).toBe(409);
    // Cleared on the PO, the void stands; Restore is the undo, and the PO
    // never voids a restored entry again.
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: null } })).status).toBe(200);
    expect((await entryOf(alex.token, id)).voided).not.toBeNull();
    expect((await api('POST', `/api/accounting/entries/${id}/restore`, { token: alex.token })).status).toBe(200);
    expect((await patch(id, { note: 'kept after all' })).status).toBe(200);
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { company: true } })).status).toBe(200);
    expect((await entryOf(alex.token, id)).voided).toBeNull();

    // A Mercury row linked as the commission does the same, and unlinking
    // leaves the void in place.
    const banked = await donePO();
    const entry = await recorded(alex.token, base({ kind: 'commission', targetId: banked }));
    const row = await bankRow('m-commission');
    expect((await api('POST', `/api/bank-transactions/${row}/link`, {
      token: alex.token, body: { orderId: banked, kind: 'commission' },
    })).status).toBe(200);
    expect((await entryOf(alex.token, entry)).voided).toMatchObject({ reason: 'Paid from the Business Account' });
    expect(await payerOf(banked)).toEqual({ kind: 'company', linked: true });
    const linked = await record(alex.token, base({ kind: 'commission', targetId: banked }));
    expect(linked.status).toBe(409);
    expect(linked.body.error).toMatch(/linked as the commission/);
    expect((await api('POST', `/api/bank-transactions/${row}/unlink`, { token: alex.token, body: {} })).status).toBe(200);
    expect((await entryOf(alex.token, entry)).voided).not.toBeNull();
    expect(await payerOf(banked)).toMatchObject({ kind: 'manager', id: alex.user.id });

    const summary = (await api<Summary>('GET', '/api/accounting/summary?from=2026-10-01&to=2026-10-31', { token: alex.token })).body;
    expect(summary.paid).toBe(100);
    expect('business' in summary).toBe(false);
  });

  it('a cost entry names the self-paid PO\'s payer both ways; a company-paid cost takes none', async () => {
    const marcus = await loginAs(MARCUS);
    const sofia = await loginAs(SOFIA);
    const self = await draftPO(marcus.token, { payment: 'self' });
    // The purchaser paid out of pocket: the entry may name them.
    const id = await recorded(alex.token, base({ kind: 'purchase', targetId: self, managerId: marcus.user.id }));
    expect(await managerOf(id)).toMatchObject({ id: marcus.user.id });
    expect((await patch(id, { managerId: sofia.user.id })).status).toBe(200);
    const [o] = await getTestDb()<{ paid_by: string }[]>`SELECT paid_by FROM orders WHERE id = ${self}`;
    expect(o.paid_by).toBe(sofia.user.id);
    expect(await poEvents(self, 'paid_by')).toEqual([expect.objectContaining({
      detail: { changes: [{ field: 'paid_by', from: 'Marcus Wright', to: 'Sofia Reyes' }] },
    })]);
    // The PO's side: the cost payer edited, the entry follows.
    expect((await api('PATCH', `/api/orders/${self}`, { token: marcus.token, body: { paidByUserId: alex.user.id } })).status).toBe(200);
    expect(await managerOf(id)).toMatchObject({ id: alex.user.id });
    // Another purchaser cannot be the payer.
    const [priya] = await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = 'priya@recycleservers.io'`;
    expect((await patch(id, { managerId: priya.id })).status).toBe(400);
    // Flipped to the company's account on the PO, the entry leaves the RMB Flow.
    expect((await api('PATCH', `/api/orders/${self}`, { token: marcus.token, body: { payment: 'company', paymentMethod: 'cash' } })).status).toBe(200);
    expect((await entryOf(alex.token, id)).voided).toMatchObject({ reason: 'Paid from the Business Account' });
    const company = await record(alex.token, base({ kind: 'purchase', targetId: self }));
    expect(company.status).toBe(409);
    expect(company.body.error).toMatch(/change that on the PO/);
  });

  it('a cost entry can\'t move the payer of a PO past review', async () => {
    const marcus = await loginAs(MARCUS);
    const sofia = await loginAs(SOFIA);
    const po = await draftPO(marcus.token, { payment: 'self' });
    const chat = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chat.png', { type: 'image/png' });
    expect((await multipart(`/api/orders/${po}/status-meta/Submission/attachments`, { file: chat }, { token: marcus.token })).status).toBe(200);
    expect((await api('POST', `/api/orders/${po}/advance`, { token: marcus.token, body: {} })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await api('POST', `/api/orders/${po}/advance`, { token: alex.token, body: {} })).status).toBe(200);
    }
    const moved = await record(alex.token, base({ kind: 'purchase', targetId: po, managerId: sofia.user.id }));
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/Ready to Pay or Done/);
    // The payer on file can still be booked; moving it from the entry can't.
    const id = await recorded(alex.token, base({ kind: 'purchase', targetId: po, managerId: marcus.user.id }));
    expect((await patch(id, { managerId: sofia.user.id })).status).toBe(409);
    const [o] = await getTestDb()<{ paid_by: string }[]>`SELECT paid_by FROM orders WHERE id = ${po}`;
    expect(o.paid_by).toBe(marcus.user.id);
  });

  it('a restored entry catches up with its PO\'s payer', async () => {
    const sofia = await loginAs(SOFIA);
    const po = await donePO();
    const id = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { company: true } })).status).toBe(200);
    // Voided, the entry is passed by while the PO moves on to Sofia.
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: sofia.user.id } })).status).toBe(200);
    expect(await managerOf(id)).toMatchObject({ id: alex.user.id });
    expect((await api('POST', `/api/accounting/entries/${id}/restore`, { token: alex.token })).status).toBe(200);
    const back = await entryOf(alex.token, id);
    expect(back.voided).toBeNull();
    expect(back.manager).toMatchObject({ id: sofia.user.id });
    // Written in the restore's transaction, after it, and read back that way.
    expect(back.events.slice(-2)).toMatchObject([
      { kind: 'restored' }, { kind: 'edited', detail: { synced: 'po' } },
    ]);
  });

  it('a deleted draft leaves the void; a nobody-on-file PO leaves the entry', async () => {
    const sofia = await loginAs(SOFIA);
    const marcus = await loginAs(MARCUS);
    const draft = await draftPO(marcus.token);
    const entry = await recorded(alex.token, base({ kind: 'commission', targetId: draft, managerId: sofia.user.id }));
    const row = await bankRow('m-draft');
    await getTestDb()`
      UPDATE bank_transactions SET order_id = ${draft}, link_kind = 'commission', linked_at = NOW() WHERE id = ${row}`;
    expect((await entryOf(alex.token, entry)).voided).not.toBeNull();
    expect((await api('DELETE', `/api/orders/${draft}`, { token: marcus.token })).status).toBe(200);
    const orphan = await entryOf(alex.token, entry);
    expect(orphan.voided).not.toBeNull();
    expect(orphan.manager).toMatchObject({ id: sofia.user.id });
    expect(orphan.target).toBeNull();
    expect(orphan.events.map(e => e.kind).sort()).toEqual(['created', 'unlinked', 'voided']);

    // Cleared on the PO, nobody is on file: the entry keeps what it recorded.
    const po = await donePO();
    const kept = await recorded(alex.token, base({ kind: 'commission', targetId: po, managerId: sofia.user.id }));
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: null } })).status).toBe(200);
    expect(await managerOf(kept)).toMatchObject({ id: sofia.user.id });
    expect((await entryOf(alex.token, kept)).voided).toBeNull();
  });

  it('keeps money booked on a deleted draft, and says which PO it was', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await draftPO(marcus.token, { payment: 'self' });
    const id = await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 200, managerId: marcus.user.id }));
    expect((await api('DELETE', `/api/orders/${po}`, { token: marcus.token })).status).toBe(200);

    const orphan = await entryOf(alex.token, id);
    expect(orphan.target).toBeNull();
    expect(orphan.events.at(-1)).toMatchObject({ kind: 'unlinked', detail: { orderId: po } });
    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { note: 'supplier kept it' } })).status).toBe(200);
    const summary = (await api<Summary>('GET', '/api/accounting/summary?from=2026-10-01&to=2026-10-31', { token: alex.token })).body;
    expect(summary.paid).toBe(200);
  });

  // ── Review against the PO's side ──────────────────────────────────────────

  type Review = {
    state: string; version: string; author: { id: string } | null; by: { id: string } | null;
    query: { to: { id: string } | null; answer: unknown } | null;
  };
  const reviewOf = async (id: string) =>
    (await api<{ entry: { review: Review } }>('GET', `/api/accounting/entries/${id}`, { token: alex.token })).body.entry.review;
  const signOff = (token: string, id: string, version: string) =>
    api<{ error?: string; code?: string }>('POST', `/api/accounting/entries/${id}/review`, { token, body: { version } });

  it('a payer the PO moves is written by the manager who moved it, who can\'t sign it off', async () => {
    const sofia = await loginAs(SOFIA);
    const marcus = await loginAs(MARCUS);
    const po = await donePO();
    const id = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    expect((await signOff(sofia.token, id, (await reviewOf(id)).version)).status).toBe(200);

    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: sofia.token, body: { userId: sofia.user.id } })).status).toBe(200);
    const moved = await reviewOf(id);
    expect(moved).toMatchObject({ state: 'changed', author: { id: sofia.user.id }, by: null });
    expect((await signOff(sofia.token, id, moved.version)).status).toBe(403);
    expect((await signOff(alex.token, id, moved.version)).status).toBe(200);

    // A purchaser's save moves the payer too, but a purchaser reviews nothing,
    // so the entry keeps the manager who wrote it.
    const draft = await draftPO(marcus.token, { payment: 'self' });
    const cost = await recorded(alex.token, base({ kind: 'purchase', targetId: draft, managerId: marcus.user.id }));
    expect((await api('PATCH', `/api/orders/${draft}`, { token: marcus.token, body: { paidByUserId: sofia.user.id } })).status).toBe(200);
    expect(await managerOf(cost)).toMatchObject({ id: sofia.user.id });
    expect(await reviewOf(cost)).toMatchObject({ author: { id: alex.user.id } });
    expect((await entryOf(alex.token, cost)).events.at(-1)).toMatchObject({ kind: 'edited', actor: { id: marcus.user.id } });
  });

  it('a sign-off that commits while the PO moves the payer is cleared, not lost', async () => {
    const sofia = await loginAs(SOFIA);
    const po = await donePO();
    const id = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    const db = getTestDb();
    let signed!: () => void;
    let commit!: () => void;
    const isSigned = new Promise<void>(r => { signed = r; });
    const held = new Promise<void>(r => { commit = r; });
    const signing = db.begin(async tx => {
      await tx`UPDATE accounting_entries SET reviewed_by = ${sofia.user.id}, reviewed_at = NOW() WHERE id = ${id}`;
      signed();
      await held;
    });
    await isSigned;
    const moving = api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { userId: sofia.user.id } });
    // The move waits on the entry the sign-off holds.
    for (let i = 0; i < 100; i++) {
      const [w] = await db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (w.n > 0) break;
      await new Promise(r => setTimeout(r, 20));
    }
    commit();
    await signing;
    expect((await moving).status).toBe(200);
    expect(await reviewOf(id)).toMatchObject({ state: 'changed', by: null });
    expect((await entryOf(alex.token, id)).events.at(-1)).toMatchObject({
      kind: 'edited', detail: { synced: 'po', clearedReview: { by: sofia.user.id } },
    });
  });

  it('only a restore of a Business Account void keeps the PO from voiding the entry again', async () => {
    const po = await donePO();
    const id = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    expect((await api('POST', `/api/accounting/entries/${id}/void`, { token: alex.token, body: { reason: 'wrong amount' } })).status).toBe(200);
    expect((await api('POST', `/api/accounting/entries/${id}/restore`, { token: alex.token })).status).toBe(200);
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: alex.token, body: { company: true } })).status).toBe(200);
    expect((await entryOf(alex.token, id)).voided).toMatchObject({ reason: 'Paid from the Business Account' });
  });

  it('a question stays with the manager it was asked of when the PO moves the payer', async () => {
    const sofia = await loginAs(SOFIA);
    const po = await donePO();
    const id = await recorded(alex.token, base({ kind: 'commission', targetId: po }));
    // Nobody wrote it (the 0196 backfill): the question goes to its manager.
    await getTestDb()`UPDATE accounting_entries SET author_id = NULL, created_by = NULL WHERE id = ${id}`;
    expect((await api('POST', `/api/accounting/entries/${id}/query`, { token: sofia.token, body: { text: 'which chat?' } })).status).toBe(200);
    expect((await api('PUT', `/api/orders/${po}/commission-paid-by`, { token: sofia.token, body: { userId: sofia.user.id } })).status).toBe(200);
    expect(await managerOf(id)).toMatchObject({ id: sofia.user.id });
    expect(await reviewOf(id)).toMatchObject({ state: 'queried', query: { to: { id: alex.user.id }, answer: null } });

    const count = async (token: string) =>
      (await api<{ asked: number }>('GET', '/api/accounting/review/count', { token })).body.asked;
    expect(await count(alex.token)).toBe(1);
    expect(await count(sofia.token)).toBe(0);
    const answer = (token: string) => api('POST', `/api/accounting/entries/${id}/answer`, { token, body: { text: 'the 10-02 one' } });
    expect((await answer(sofia.token)).status).toBe(403);
    expect((await answer(alex.token)).status).toBe(200);
  });

  it('a deleted draft clears the sign-off its record was part of', async () => {
    const sofia = await loginAs(SOFIA);
    const marcus = await loginAs(MARCUS);
    const po = await draftPO(marcus.token, { payment: 'self' });
    const signed = await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 200, managerId: marcus.user.id }));
    const open = await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 30, managerId: marcus.user.id }));
    expect((await signOff(sofia.token, signed, (await reviewOf(signed)).version)).status).toBe(200);
    const stale = (await reviewOf(open)).version;
    expect((await api('DELETE', `/api/orders/${po}`, { token: marcus.token })).status).toBe(200);

    expect(await reviewOf(signed)).toMatchObject({ state: 'changed', by: null, author: { id: alex.user.id } });
    const row = (await api<{ rows: { id: string; cleared: unknown }[] }>('GET', '/api/accounting/review?tab=mine', { token: sofia.token }))
      .body.rows.find(r => r.id === signed);
    expect(row?.cleared).toMatchObject({ reviewer: { id: sofia.user.id }, changes: { targetId: { from: po, to: null } } });
    // A page that still showed the PO can't sign off what it no longer says.
    const late = await signOff(sofia.token, open, stale);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('changed');
  });

  it('the purchaser who paid a self-paid cost can take its refund', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const po = await draftPO(marcus.token, { payment: 'self' });
    const refund = await record(alex.token, base({ kind: 'purchase', direction: 'in', targetId: po, amount: 20, managerId: marcus.user.id }));
    expect(refund.status, refund.body.error).toBe(201);
    const paid = await recorded(alex.token, base({ kind: 'purchase', targetId: po, amount: 200, managerId: marcus.user.id }));
    expect((await patch(paid, { direction: 'in' })).status).toBe(200);
    // Not another purchaser: they paid for nothing on this PO.
    const other = await record(alex.token, base({ kind: 'purchase', direction: 'in', targetId: po, managerId: priya.user.id }));
    expect(other.status).toBe(400);
  });

  it('a payer deactivated since stays on an entry whose other fields change', async () => {
    const sofia = await loginAs(SOFIA);
    const id = await recorded(alex.token, base({ managerId: sofia.user.id }));
    await getTestDb()`UPDATE users SET active = FALSE WHERE id = ${sofia.user.id}`;
    expect((await patch(id, { direction: 'in' })).status).toBe(200);
    expect((await patch(id, { managerId: sofia.user.id, amount: 90 })).status).toBe(200);
    // Booking someone deactivated is still refused.
    const other = await recorded(alex.token, base({}));
    expect((await patch(other, { managerId: sofia.user.id })).status).toBe(400);
  });

  it('warns on a sale the Business Account also received', async () => {
    const sofia = await loginAs(SOFIA);
    const so = await shippedSO(alex.token);
    const id = await recorded(alex.token, base({ kind: 'sale', direction: 'in', targetId: so.id, amount: 640 }));
    const checksOf = async () =>
      (await api<{ rows: { id: string; checks: { kind: string; tone: string }[] }[] }>(
        'GET', '/api/accounting/review?tab=mine', { token: sofia.token })).body.rows.find(r => r.id === id)!.checks;
    expect((await checksOf()).map(c => c.kind)).not.toContain('businessReceived');

    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [{ externalId: 'm-sale', amount: 90, counterparty: 'Buyer', postedAt: new Date(NOW - DAY) }]),
    ]);
    const [row] = await getTestDb()<{ id: string }[]>`SELECT id FROM bank_transactions WHERE external_id = 'm-sale'`;
    expect((await api('POST', `/api/bank-transactions/${row.id}/link`, {
      token: alex.token, body: { sellOrderId: so.id },
    })).status).toBe(200);
    expect(await checksOf()).toContainEqual({ kind: 'businessReceived', tone: 'warn' });
    // A warning keeps it out of the bulk sign-off.
    const { version } = await reviewOf(id);
    const bulk = await api<{ reviewed: string[]; skipped: { id: string }[] }>('POST', '/api/accounting/review/bulk', {
      token: sofia.token, body: { entries: [{ id, version }] },
    });
    expect(bulk.body.skipped.map(s => s.id)).toEqual([id]);
  });
});

// The book started empty, so the payers already on file were booked once: a
// PO's Paid by as the commission, a Done sell order's receiver as the sale.
describe('migration 0196 books the payers already on file', () => {
  let alex: Awaited<ReturnType<typeof loginAs>>;
  let sofia: Awaited<ReturnType<typeof loginAs>>;

  beforeEach(async () => {
    await resetDb();
    alex = await loginAs(ALEX);
    sofia = await loginAs(SOFIA);
    await getTestDb()`
      INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date)
      VALUES ('USD', 'CNY', 7.1, 'manual', '2026-09-01'), ('USD', 'CNY', 7.3, 'manual', '2026-10-01')`;
  });

  const replay = async () => {
    const file = new URL('../migrations/0196_backfill_accounting_from_payers.sql', import.meta.url);
    await getTestDb().unsafe(readFileSync(fileURLToPath(file), 'utf8'));
  };
  const setPaidBy = async (id: string, body: Record<string, unknown>) =>
    expect((await api('PUT', `/api/orders/${id}/commission-paid-by`, { token: alex.token, body })).status).toBe(200);
  // A receipt as the AI rename names it, uploaded at the given instant.
  const poReceipt = (id: string, filename: string, at: string) => getTestDb()`
    INSERT INTO order_status_attachments
      (order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by, uploaded_at)
    VALUES (${id}, 'Commission', ${filename}, 4, 'image/jpeg', ${`k-${id}-${filename}`}, 'https://x/r.jpg',
            ${alex.user.id}, ${at})`;
  const soReceipt = (id: string, filename: string) => getTestDb()`
    INSERT INTO sell_order_status_attachments
      (sell_order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by)
    VALUES (${id}, 'Done', ${filename}, 4, 'image/jpeg', ${`k-${id}-${filename}`}, 'https://x/r.jpg', ${alex.user.id})`;
  const doneSO = async (): Promise<string> => {
    const { id } = await shippedSO(alex.token);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: alex.token, body: { to: 'Awaiting payment', note: 'a' },
    })).status).toBe(200);
    await signOffAll(id);
    expect((await api('POST', `/api/sell-orders/${id}/status`, { token: alex.token, body: { to: 'Done', note: 'paid' } })).status).toBe(200);
    return id;
  };
  const booked = async () => (await listOf(alex.token, 'limit=200')).rows;
  const chinaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

  it('books each commission a manager paid, at its day\'s rate, once', async () => {
    const paid = await donePO();
    await setPaidBy(paid, { userId: alex.user.id });
    // 18:00 UTC is the next morning in China, where the book is kept.
    await poReceipt(paid, '2026-09-24-alipay-150.00.jpg', '2026-09-24T18:00:00Z');
    const unshot = await donePO();
    await setPaidBy(unshot, { userId: sofia.user.id });
    const mixed = await donePO();
    await setPaidBy(mixed, { userId: alex.user.id });
    await poReceipt(mixed, '2026-09-24-alipay-50.00.jpg', '2026-09-24T01:00:00Z');
    await poReceipt(mixed, '2026-09-24-weixinpay-50.00-2.jpg', '2026-09-24T02:00:00Z');
    const company = await donePO();
    await setPaidBy(company, { company: true });
    const banked = await donePO();
    await setPaidBy(banked, { userId: alex.user.id });
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [{ externalId: 'm-commission', amount: -50, counterparty: 'Marcus', postedAt: new Date(NOW - DAY) }]),
    ]);
    const [bank] = await getTestDb()<{ id: string }[]>`SELECT id FROM bank_transactions WHERE external_id = 'm-commission'`;
    expect((await api('POST', `/api/bank-transactions/${bank.id}/link`, {
      token: alex.token, body: { orderId: banked, kind: 'commission' },
    })).status).toBe(200);
    const recordedAlready = await donePO();
    await setPaidBy(recordedAlready, { userId: alex.user.id });
    await recorded(alex.token, {
      direction: 'out', kind: 'commission', amount: 100, currency: 'CNY', method: 'cash',
      occurredOn: '2026-10-05', managerId: alex.user.id, targetId: recordedAlready,
    });
    await donePO();

    await replay();
    await replay();

    const rows = await booked();
    const of = (po: string) => rows.filter(r => r.target?.id === po);
    expect(of(company)).toHaveLength(0);
    expect(of(banked)).toHaveLength(0);
    expect(of(recordedAlready)).toHaveLength(1);
    expect(rows).toHaveLength(4);

    const [{ name: marcusName }] = await getTestDb()<{ name: string }[]>`
      SELECT name FROM users WHERE email = ${MARCUS}`;
    const [first] = of(paid);
    const e = (await api<{ entry: Entry & {
      targetFacts: { amount: number }; events: { kind: string; actor: unknown; detail: Record<string, unknown> }[];
    } }>('GET', `/api/accounting/entries/${first.id}`, { token: alex.token })).body.entry;
    expect(e.targetFacts.amount).toBeGreaterThan(0);
    expect(e).toMatchObject({
      direction: 'out', kind: 'commission', currency: 'USD', amount: e.targetFacts.amount, fxRate: 7.1,
      amountCny: Math.round(e.targetFacts.amount * 7.1 * 100) / 100, method: 'alipay', occurredOn: '2026-09-25',
      manager: { id: alex.user.id }, counterparty: marcusName,
    });
    expect(e.events).toEqual([expect.objectContaining({
      kind: 'created', actor: null, detail: expect.objectContaining({ backfilled: 'commission_paid_by' }),
    })]);

    expect(of(unshot)[0]).toMatchObject({ manager: { id: sofia.user.id }, occurredOn: chinaToday(), fxRate: 7.3, method: 'other' });
    expect(of(mixed)[0]).toMatchObject({ method: 'other', occurredOn: '2026-09-24' });

    // Numbered in book order.
    const ids = [of(mixed)[0].id, first.id, of(unshot)[0].id].map(id => Number(id.slice(3)));
    expect(ids).toEqual([ids[0], ids[0] + 1, ids[0] + 2]);
  });

  it('books each Done sale through its receiver, in the order\'s own currency', async () => {
    const usd = await doneSO();
    await getTestDb()`
      UPDATE sell_orders SET payment_received_by = ${sofia.user.id}, done_at = '2026-10-02T20:00:00Z'
      WHERE id = ${usd}`;
    await soReceipt(usd, '2026-10-02-weixinpay-657.00.jpg');
    const cny = await doneSO();
    await getTestDb()`
      UPDATE sell_orders SET payment_received_by = ${alex.user.id}, currency_code = 'CNY', fx_rate_to_usd = 0.137
      WHERE id = ${cny}`;
    await getTestDb()`UPDATE sell_order_lines SET source_currency = 'CNY', source_unit_price = 650 WHERE sell_order_id = ${cny}`;
    const awaiting = (await shippedSO(alex.token)).id;
    expect((await api('POST', `/api/sell-orders/${awaiting}/status`, {
      token: alex.token, body: { to: 'Awaiting payment', note: 'a' },
    })).status).toBe(200);
    await getTestDb()`UPDATE sell_orders SET payment_received_by = ${alex.user.id} WHERE id = ${awaiting}`;

    await replay();
    await replay();

    const rows = await booked();
    expect(rows).toHaveLength(2);
    const of = (so: string) => rows.find(r => r.target?.id === so);
    expect(of(usd)).toMatchObject({
      direction: 'in', kind: 'sale', currency: 'USD', amount: 90, fxRate: 7.3, amountCny: 657,
      occurredOn: '2026-10-03', method: 'wechat', manager: { id: sofia.user.id }, target: { type: 'so', id: usd },
    });
    expect(of(cny)).toMatchObject({ currency: 'CNY', amount: 650, fxRate: null, amountCny: 650, manager: { id: alex.user.id } });
    expect((await entryOf(alex.token, of(cny)!.id)).events).toEqual([expect.objectContaining({
      kind: 'created', detail: expect.objectContaining({ backfilled: 'payment_received_by' }),
    })]);
  });
});

// Entries written before the link existed catch up with their PO once.
describe('migration 0199 brings each entry in line with its PO', () => {
  let alex: Awaited<ReturnType<typeof loginAs>>;
  beforeEach(async () => {
    await resetDb();
    alex = await loginAs(ALEX);
  });
  const replay = async () => {
    const file = new URL('../migrations/0199_accounting_payer_sync.sql', import.meta.url);
    await getTestDb().unsafe(readFileSync(fileURLToPath(file), 'utf8'));
  };

  it('voids what the Business Account paid, moves a stale payer, once, and says so', async () => {
    const sofia = await loginAs(SOFIA);
    const company = await draftPO(alex.token, { payment: 'self' });
    const stale = await recorded(alex.token, {
      direction: 'out', kind: 'purchase', amount: 100, currency: 'CNY', method: 'cash',
      occurredOn: '2026-10-05', managerId: alex.user.id, targetId: company,
    });
    const paid = await donePO();
    const moved = await recorded(alex.token, {
      direction: 'out', kind: 'commission', amount: 100, currency: 'CNY', method: 'cash',
      occurredOn: '2026-10-05', managerId: sofia.user.id, targetId: paid,
    });
    const nobody = await donePO();
    const kept = await recorded(alex.token, {
      direction: 'out', kind: 'commission', amount: 100, currency: 'CNY', method: 'cash',
      occurredOn: '2026-10-05', managerId: sofia.user.id, targetId: nobody,
    });
    // As the book stood before the link: the POs moved, the entries did not.
    await getTestDb()`ALTER TABLE orders DISABLE TRIGGER orders_sync_accounting_payer`;
    await getTestDb()`UPDATE orders SET payment = 'company', payment_method = 'cash', paid_by = NULL WHERE id = ${company}`;
    await getTestDb()`UPDATE orders SET commission_paid_by = ${alex.user.id} WHERE id = ${paid}`;
    await getTestDb()`UPDATE orders SET commission_paid_by = NULL WHERE id = ${nobody}`;
    await getTestDb()`ALTER TABLE orders ENABLE TRIGGER orders_sync_accounting_payer`;

    await replay();
    await replay();

    const gone = await entryOf(alex.token, stale);
    expect(gone.voided).toMatchObject({ reason: 'Paid from the Business Account' });
    expect(gone.events.filter(e => e.kind === 'voided')).toEqual([expect.objectContaining({
      actor: null, detail: { backfilled: 'payer', reason: 'Paid from the Business Account' },
    })]);
    const now = await entryOf(alex.token, moved);
    expect(now.manager).toMatchObject({ id: alex.user.id });
    expect(now.events.filter(e => e.detail.backfilled === 'payer')).toEqual([expect.objectContaining({
      kind: 'edited', detail: { backfilled: 'payer', changes: { managerId: { from: sofia.user.id, to: alex.user.id } } },
    })]);
    expect((await entryOf(alex.token, kept)).manager).toMatchObject({ id: sofia.user.id });
  });
});
