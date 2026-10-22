import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';
import { mockFrankfurter } from './helpers/fx';

// Accounting review: one manager who didn't write an entry signs it off. The
// author can't, a stale page can't, an edit to anything but the note clears
// the sign-off, and every step lands in the entry's append-only history.

type Review = {
  state: 'open' | 'changed' | 'queried' | 'reviewed';
  version: string;
  author: { id: string; name: string } | null;
  by: { id: string; name: string } | null;
  query: {
    by: { id: string } | null; text: string; to: { id: string; name: string } | null;
    answer: { by: { id: string } | null; text: string | null } | null;
  } | null;
};
type Entry = { id: string; review: Review | null };
type Check = { kind: string; tone: string; verdict?: string; of?: string };
type ReviewRow = Entry & { checks: Check[]; cleared: { reviewer: { name: string } | null; changes: Record<string, { from: unknown; to: unknown }> } | null };
type Queue = { rows: ReviewRow[]; counts: Record<'mine' | 'queried' | 'others' | 'reviewed', number> };

const PO_BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [{ category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40 }],
};

describe('accounting review', () => {
  let alex: Awaited<ReturnType<typeof loginAs>>;
  let sofia: Awaited<ReturnType<typeof loginAs>>;
  let base: (over: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7, '2026-10-01');
    await getTestDb()`
      INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date)
      VALUES ('USD', 'CNY', 7.0, 'manual', '2026-10-01')`;
    alex = await loginAs(ALEX);
    sofia = await loginAs(SOFIA);
    base = over => ({
      direction: 'out', kind: 'other', amount: 100, currency: 'CNY', method: 'alipay',
      occurredOn: '2026-10-05', managerId: alex.user.id, ...over,
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const record = async (token: string, body: Record<string, unknown>) => {
    const r = await api<{ id: string; error?: string }>('POST', '/api/accounting/entries', { token, body });
    expect(r.status, r.body.error).toBe(201);
    return r.body.id;
  };
  const entry = async (token: string, id: string) =>
    (await api<{ entry: Entry & { events: { kind: string; detail: Record<string, unknown> }[] } }>(
      'GET', `/api/accounting/entries/${id}`, { token })).body.entry;
  const queue = async (token: string, tab = 'mine') =>
    (await api<Queue>('GET', `/api/accounting/review?tab=${tab}`, { token })).body;
  const review = (token: string, id: string, version: string) =>
    api<{ error?: string; code?: string }>('POST', `/api/accounting/entries/${id}/review`, { token, body: { version } });
  const versionOf = async (id: string) => (await entry(alex.token, id)).review!.version;

  it('waits on any manager but its author, who cannot sign it off', async () => {
    const id = await record(alex.token, base({}));
    const e = await entry(alex.token, id);
    expect(e.review).toMatchObject({ state: 'open', author: { id: alex.user.id }, by: null });

    expect((await queue(alex.token, 'mine')).rows.map(r => r.id)).not.toContain(id);
    expect((await queue(alex.token, 'others')).rows.map(r => r.id)).toContain(id);
    expect((await queue(sofia.token, 'mine')).rows.map(r => r.id)).toContain(id);

    const own = await review(alex.token, id, e.review!.version);
    expect(own.status).toBe(403);

    expect((await review(sofia.token, id, e.review!.version)).status).toBe(200);
    expect((await entry(alex.token, id)).review).toMatchObject({ state: 'reviewed', by: { id: sofia.user.id } });
    expect((await review(sofia.token, id, e.review!.version)).status).toBe(409);
    expect((await queue(sofia.token, 'reviewed')).rows.map(r => r.id)).toContain(id);
  });

  it('refuses a sign-off for a version the page never showed', async () => {
    const id = await record(alex.token, base({}));
    const stale = await versionOf(id);
    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { amount: 120 } })).status).toBe(200);
    const r = await review(sofia.token, id, stale);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('changed');
    expect((await review(sofia.token, id, await versionOf(id))).status).toBe(200);
  });

  it('an edit to anything but the note clears the sign-off and names a new author', async () => {
    const id = await record(alex.token, base({ amount: 1800 }));
    expect((await review(sofia.token, id, await versionOf(id))).status).toBe(200);

    // The note explains the entry; it keeps the review.
    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { note: 'fee incl.' } })).status).toBe(200);
    expect((await entry(alex.token, id)).review!.state).toBe('reviewed');

    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: sofia.token, body: { amount: 1880 } })).status).toBe(200);
    const e = await entry(alex.token, id);
    expect(e.review).toMatchObject({ state: 'changed', author: { id: sofia.user.id }, by: null });
    const edited = e.events.filter(ev => ev.kind === 'edited').at(-1)!;
    expect(edited.detail.clearedReview).toMatchObject({ by: sofia.user.id });

    // The editor wrote this version now; Alex checks her change.
    expect((await review(sofia.token, id, e.review!.version)).status).toBe(403);
    const row = (await queue(alex.token, 'mine')).rows.find(r => r.id === id)!;
    expect(row.review!.state).toBe('changed');
    expect(row.cleared).toMatchObject({ reviewer: { name: 'Sofia Reyes' }, changes: { amount: { from: 1800, to: 1880 } } });
    expect((await review(alex.token, id, e.review!.version)).status).toBe(200);
  });

  it('only the reviewer withdraws a review', async () => {
    const id = await record(alex.token, base({}));
    expect((await review(sofia.token, id, await versionOf(id))).status).toBe(200);
    expect((await api('DELETE', `/api/accounting/entries/${id}/review`, { token: alex.token })).status).toBe(403);
    expect((await api('DELETE', `/api/accounting/entries/${id}/review`, { token: sofia.token })).status).toBe(200);
    expect((await entry(alex.token, id)).review!.state).toBe('open');
  });

  it('a question goes to the author, and the answer sends it back to review', async () => {
    const id = await record(alex.token, base({}));
    const ask = (token: string, text: string) =>
      api<{ error?: string }>('POST', `/api/accounting/entries/${id}/query`, { token, body: { text } });
    expect((await ask(sofia.token, '  ')).status).toBe(400);
    expect((await ask(alex.token, 'mine?')).status).toBe(403);
    expect((await ask(sofia.token, 'Was the ¥20 a fee?')).status).toBe(200);
    expect((await ask(sofia.token, 'again')).status).toBe(409);

    const told = await getTestDb()<{ title: string; body: string }[]>`
      SELECT title, body FROM notifications WHERE user_id = ${alex.user.id} AND kind = 'accounting_query'`;
    expect(told).toEqual([{ title: `Sofia Reyes asked about ${id}`, body: 'Was the ¥20 a fee?' }]);

    expect((await entry(alex.token, id)).review).toMatchObject({
      state: 'queried', query: { text: 'Was the ¥20 a fee?', to: { id: alex.user.id }, answer: null },
    });
    expect((await queue(sofia.token, 'mine')).rows.map(r => r.id)).not.toContain(id);
    expect((await queue(sofia.token, 'queried')).rows.map(r => r.id)).toContain(id);

    const answer = (token: string) =>
      api('POST', `/api/accounting/entries/${id}/answer`, { token, body: { text: 'Yes, the transfer fee.' } });
    expect((await answer(sofia.token)).status).toBe(403);
    expect((await answer(alex.token)).status).toBe(200);
    expect((await entry(alex.token, id)).review).toMatchObject({
      state: 'open', query: { text: 'Was the ¥20 a fee?', answer: { text: 'Yes, the transfer fee.' } },
    });
    // Signing off clears the exchange with it.
    expect((await review(sofia.token, id, await versionOf(id))).status).toBe(200);
    expect((await entry(alex.token, id)).review).toMatchObject({ state: 'reviewed', query: null });
  });

  it('an edit answers an open question, and only the asker withdraws one', async () => {
    const id = await record(alex.token, base({}));
    const ask = () => api('POST', `/api/accounting/entries/${id}/query`, { token: sofia.token, body: { text: 'amount?' } });
    expect((await ask()).status).toBe(200);
    expect((await api('DELETE', `/api/accounting/entries/${id}/query`, { token: alex.token })).status).toBe(403);
    expect((await api('DELETE', `/api/accounting/entries/${id}/query`, { token: sofia.token })).status).toBe(200);
    expect((await entry(alex.token, id)).review).toMatchObject({ state: 'open', query: null });

    expect((await ask()).status).toBe(200);
    expect((await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { amount: 90 } })).status).toBe(200);
    expect((await entry(alex.token, id)).review).toMatchObject({
      state: 'open', query: { text: 'amount?', answer: { by: { id: alex.user.id }, text: null } },
    });
  });

  it('a restored entry comes back To review', async () => {
    const id = await record(alex.token, base({}));
    const version = await versionOf(id);
    expect((await review(sofia.token, id, version)).status).toBe(200);
    expect((await api('DELETE', `/api/accounting/entries/${id}/review`, { token: sofia.token })).status).toBe(200);
    expect((await api('POST', `/api/accounting/entries/${id}/void`, { token: alex.token, body: { reason: 'typo' } })).status).toBe(200);
    expect((await entry(alex.token, id)).review).toBeNull();
    expect((await review(sofia.token, id, version)).status).toBe(409);
    expect((await review(sofia.token, id, version)).body.error).toMatch(/voided/);
    expect((await api('POST', `/api/accounting/entries/${id}/restore`, { token: alex.token })).status).toBe(200);
    expect((await entry(alex.token, id)).review).toMatchObject({ state: 'open', by: null });
  });

  it('weighs each entry against its record, the FX ledger and its look-alikes', async () => {
    const po = await api<{ id: string }>('POST', '/api/orders', { token: alex.token, body: PO_BODY });
    expect(po.status).toBe(201);
    // PO cost $20 ≈ ¥140 at the ledger's 7.0.
    const fair = await record(alex.token, base({ kind: 'purchase', targetId: po.body.id, amount: 140 }));
    const usd = await record(alex.token, base({ amount: 10, currency: 'USD', fxRate: 7.4, counterparty: 'DHL' }));
    const dupA = await record(alex.token, base({ amount: 55, counterparty: 'Lin Hardware' }));
    const dupB = await record(alex.token, base({ amount: 55, counterparty: 'lin hardware', occurredOn: '2026-10-07' }));

    let rows = (await queue(sofia.token)).rows;
    const checks = (id: string) => rows.find(r => r.id === id)!.checks;
    expect(checks(fair)).toEqual([expect.objectContaining({ kind: 'record', verdict: 'matches', tone: 'ok' })]);
    expect(checks(usd)).toEqual([
      expect.objectContaining({ kind: 'noRecord', tone: 'info' }),
      expect.objectContaining({ kind: 'rate', tone: 'warn', ledgerRate: 7 }),
    ]);
    expect(checks(dupA)).toContainEqual(expect.objectContaining({ kind: 'duplicate', of: dupB }));

    // A second payment for the same PO puts the book over its cost.
    await record(alex.token, base({ kind: 'purchase', targetId: po.body.id, amount: 60, method: 'bank' }));
    rows = (await queue(sofia.token)).rows;
    expect(checks(fair)).toEqual([expect.objectContaining({ kind: 'record', verdict: 'over', tone: 'warn' })]);
  });

  it('signs off in bulk only the plain entries with no warning', async () => {
    const plain = await record(alex.token, base({ counterparty: 'A' }));
    const dupA = await record(alex.token, base({ amount: 55, counterparty: 'B' }));
    await record(alex.token, base({ amount: 55, counterparty: 'B', occurredOn: '2026-10-06' }));
    const own = await record(sofia.token, base({ managerId: sofia.user.id, counterparty: 'C' }));
    const changed = await record(alex.token, base({ counterparty: 'D' }));
    expect((await review(sofia.token, changed, await versionOf(changed))).status).toBe(200);
    expect((await api('PATCH', `/api/accounting/entries/${changed}`, { token: alex.token, body: { amount: 101 } })).status).toBe(200);
    const stale = await record(alex.token, base({ counterparty: 'E' }));
    const staleVersion = await versionOf(stale);
    expect((await api('PATCH', `/api/accounting/entries/${stale}`, { token: alex.token, body: { method: 'cash' } })).status).toBe(200);

    const ids = [plain, dupA, own, changed, stale];
    const versions = await Promise.all(ids.map(id => (id === stale ? staleVersion : versionOf(id))));
    const r = await api<{ reviewed: string[]; skipped: { id: string; reason: string }[] }>(
      'POST', '/api/accounting/review/bulk',
      { token: sofia.token, body: { entries: ids.map((id, i) => ({ id, version: versions[i] })) } });
    expect(r.status).toBe(200);
    expect(r.body.reviewed).toEqual([plain]);
    expect(Object.fromEntries(r.body.skipped.map(s => [s.id, s.reason]))).toEqual({
      [dupA]: 'it has a warning',
      [own]: 'you wrote this version — another manager reviews it',
      [changed]: 'changed or queried entries are reviewed one by one',
      [stale]: 'the entry changed since you opened it',
    });
  });

  it('an entry nobody wrote is any manager\'s to review, and its questions go to its manager', async () => {
    const id = await record(alex.token, base({}));
    await getTestDb()`UPDATE accounting_entries SET author_id = NULL, created_by = NULL WHERE id = ${id}`;
    expect((await queue(alex.token, 'mine')).rows.map(r => r.id)).toContain(id);
    // Alex's own money: a question from him would be to himself.
    expect((await api('POST', `/api/accounting/entries/${id}/query`, { token: alex.token, body: { text: '?' } })).status).toBe(400);
    expect((await api('POST', `/api/accounting/entries/${id}/query`, { token: sofia.token, body: { text: 'right?' } })).status).toBe(200);
    expect((await entry(alex.token, id)).review!.query!.to).toEqual({ id: alex.user.id, name: 'Alex Chen' });
    expect((await api('POST', `/api/accounting/entries/${id}/answer`, { token: alex.token, body: { text: 'yes' } })).status).toBe(200);
  });

  it('counts what waits on each manager, in the badge and the band', async () => {
    const id = await record(alex.token, base({}));
    await record(sofia.token, base({ managerId: sofia.user.id }));
    const count = async (token: string) => (await api<{ forMe: number; asked: number }>('GET', '/api/accounting/review/count', { token })).body;
    expect(await count(sofia.token)).toEqual({ forMe: 1, asked: 0 });
    expect((await api('POST', `/api/accounting/entries/${id}/query`, { token: sofia.token, body: { text: '?' } })).status).toBe(200);
    expect(await count(alex.token)).toEqual({ forMe: 1, asked: 1 });

    const sum = await api<{ review: Record<string, number> }>('GET', '/api/accounting/summary?from=2026-10-01&to=2026-10-31', { token: sofia.token });
    expect(sum.body.review).toMatchObject({
      entries: 2, reviewed: 0, queried: 1, forMe: 0, waitingOnOthers: 1, movedCny: 200, activeManagers: 2,
    });
    const filtered = await api<{ rows: Entry[] }>('GET', '/api/accounting/entries?review=queried', { token: alex.token });
    expect(filtered.body.rows.map(r => r.id)).toEqual([id]);
  });

  it('is manager-only', async () => {
    const id = await record(alex.token, base({}));
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', '/api/accounting/review', { token })).status).toBe(403);
    expect((await review(token, id, await versionOf(id))).status).toBe(403);
  });

  it('keeps the history append-only, and shows it in Activity', async () => {
    const id = await record(alex.token, base({}));
    expect((await review(sofia.token, id, await versionOf(id))).status).toBe(200);
    await expect(getTestDb()`UPDATE accounting_entry_events SET detail = '{}' WHERE entry_id = ${id}`).rejects.toThrow(/append-only/);
    await expect(getTestDb()`DELETE FROM accounting_entry_events WHERE entry_id = ${id}`).rejects.toThrow(/append-only/);

    type Feed = { events: { area: string; kind: string; action: string; target: string; targetRef: string; detail: Record<string, unknown> }[]; counts: Record<string, number> };
    const feed = await api<Feed>('GET', '/api/activity?area=acct', { token: alex.token });
    expect(feed.status).toBe(200);
    expect(feed.body.events.map(e => [e.kind, e.action, e.target])).toEqual([
      ['reviewed', 'reviewed', id], ['created', 'created', id],
    ]);
    expect(feed.body.events[0].detail).toMatchObject({ amountCny: 100, entry: { direction: 'out', kind: 'other' } });
    expect(feed.body.counts.acct).toBe(2);
    const reviewedOnly = await api<Feed>('GET', '/api/activity?area=acct&action=reviewed', { token: alex.token });
    expect(reviewedOnly.body.events.map(e => e.kind)).toEqual(['reviewed']);
    const searched = await api<Feed>('GET', `/api/activity?q=${encodeURIComponent(id)}`, { token: alex.token });
    expect(searched.body.events.every(e => e.area === 'acct')).toBe(true);
  });
});
