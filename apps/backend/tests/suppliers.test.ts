// Clients — ownership scope, the adopt flow, and the follow-up loop, against a
// real database so the FKs, the generated match_key and the derived rollups are
// all exercised.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

type Client = {
  id: string; name: string; tier: string; health: string; cadenceDays: number;
  poCount: number; spendTotal: number; dueState: string; nextFollowUpAt: string | null;
  ownerId: string | null; ownerName: string | null; status: string;
  typicalGapDays: number | null; daysSinceLastPo: number | null; itemTypes: string[];
};
type ListBody = { items: Client[]; counts: { due: number; soon: number; quiet: number; total: number } };

async function mkClient(token: string, name: string, extra: Record<string, unknown> = {}) {
  const r = await api<{ id: string }>('POST', '/api/suppliers', { token, body: { name, ...extra } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
}

/** Give a client a purchase-order history directly, so the derived rollups
 *  (tier, rhythm, spend) have something real to compute from. */
async function givePOs(supplierId: string, userEmail: string, daysAgo: number[], cost: number) {
  const sql = getTestDb();
  const [{ id: userId }] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${userEmail}`;
  const [{ id: whId }] = await sql<{ id: string }[]>`SELECT id FROM warehouses LIMIT 1`;
  for (const d of daysAgo) {
    const oid = `PO-T${Math.floor(Math.random() * 1e9)}`;
    await sql`
      INSERT INTO orders (id, user_id, category, warehouse_id, lifecycle, total_cost,
                          supplier_id, created_at)
      VALUES (${oid}, ${userId}, 'RAM', ${whId}, 'done', ${cost}, ${supplierId},
              NOW() - (${d} || ' days')::interval)`;
    await sql`
      INSERT INTO order_lines (order_id, category, item_type, qty, unit_cost)
      VALUES (${oid}, 'RAM', 'RAM', 10, ${cost / 10})`;
  }
}

describe('clients — who can see whose book', () => {
  beforeEach(async () => { await resetDb(); });

  it("a purchaser sees only their own, a manager sees everyone's", async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    await mkClient(marcus.token, 'Denver Datacenter Liquidators');
    await mkClient(priya.token, 'Summit IT Asset Disposition');

    const mine = await api<ListBody>('GET', '/api/suppliers', { token: marcus.token });
    expect(mine.body.items.map((i) => i.name)).toEqual(['Denver Datacenter Liquidators']);

    const hers = await api<ListBody>('GET', '/api/suppliers', { token: priya.token });
    expect(hers.body.items.map((i) => i.name)).toEqual(['Summit IT Asset Disposition']);

    const boss = await api<ListBody>('GET', '/api/suppliers', { token: (await loginAs(ALEX)).token });
    expect(boss.body.items.length).toBe(2);
  });

  it("404s rather than leaking another purchaser's client", async () => {
    const priya = await loginAs(PRIYA);
    const id = await mkClient(priya.token, 'Front Range Recyclers');
    const marcus = await loginAs(MARCUS);
    expect((await api('GET', `/api/suppliers/${id}`, { token: marcus.token })).status).toBe(404);
    expect((await api('PATCH', `/api/suppliers/${id}`, {
      token: marcus.token, body: { city: 'Denver' } })).status).toBe(403);
  });

  it('two purchasers may each keep the same seller', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    await mkClient(marcus.token, "John's Servers", { zip: '80012' });
    await mkClient(priya.token, "John's Servers", { zip: '80012' });
    const boss = await api<ListBody>('GET', '/api/suppliers', { token: (await loginAs(ALEX)).token });
    expect(boss.body.items.filter((i) => i.name === "John's Servers").length).toBe(2);
  });

  it('refuses a duplicate in your own book and names who has it', async () => {
    const marcus = await loginAs(MARCUS);
    await mkClient(marcus.token, "John's Servers", { zip: '80012' });
    const dup = await api<{ error: string }>('POST', '/api/suppliers', {
      token: marcus.token, body: { name: '  johns   SERVERS ', zip: '80012' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already in/i);
  });
});

describe('clients — derived tier, rhythm and health', () => {
  beforeEach(async () => { await resetDb(); });

  it('ranks by recency-weighted spend and reads each rhythm separately', async () => {
    const marcus = await loginAs(MARCUS);
    const big = await mkClient(marcus.token, 'Front Range Recyclers');
    const quiet = await mkClient(marcus.token, 'Denver Datacenter Liquidators');
    const slow = await mkClient(marcus.token, 'Mike Trujillo');

    await givePOs(big, MARCUS, [5, 20, 35, 50, 65], 9000);
    // buys every ~21 days, silent 58 -> 2.8x rhythm
    await givePOs(quiet, MARCUS, [58, 79, 100, 121], 4000);
    // buys every ~120 days, silent 70 -> perfectly normal
    await givePOs(slow, MARCUS, [70, 190, 310], 300);

    const r = await api<ListBody>('GET', '/api/suppliers', { token: marcus.token });
    const by = Object.fromEntries(r.body.items.map((i) => [i.name, i]));

    expect(by['Front Range Recyclers'].tier).toBe('A');
    expect(by['Front Range Recyclers'].health).toBe('ok');
    expect(by['Front Range Recyclers'].cadenceDays).toBe(14);

    expect(by['Denver Datacenter Liquidators'].health).toBe('quiet');
    expect(by['Denver Datacenter Liquidators'].typicalGapDays).toBe(21);

    // same silence, different meaning — this is the whole point of the rule
    expect(by['Mike Trujillo'].daysSinceLastPo).toBeGreaterThan(60);
    expect(by['Mike Trujillo'].health).toBe('ok');

    expect(by['Front Range Recyclers'].itemTypes).toContain('RAM');
    expect(r.body.counts.quiet).toBe(1);
  });

  it('keeps a client under the spend floor out of tier A', async () => {
    const marcus = await loginAs(MARCUS);
    const tiny = await mkClient(marcus.token, 'Corner Shop');
    await givePOs(tiny, MARCUS, [3], 100);            // $100 < $500 floor
    const r = await api<ListBody>('GET', '/api/suppliers', { token: marcus.token });
    expect(r.body.items.find((i) => i.name === 'Corner Shop')!.tier).toBe('C');
  });

  it('lets a manager pin a tier the formula would not give', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Strategic DDR5 Source');
    expect((await api('PATCH', `/api/suppliers/${id}`, {
      token: marcus.token, body: { tierOverride: 'A' } })).status).toBe(403);
    const boss = await loginAs(ALEX);
    expect((await api('PATCH', `/api/suppliers/${id}`, {
      token: boss.token, body: { tierOverride: 'A' } })).status).toBe(200);
    const r = await api<ListBody>('GET', '/api/suppliers', { token: marcus.token });
    expect(r.body.items[0].tier).toBe('A');
    expect(r.body.items[0].cadenceDays).toBe(14);
  });
});

describe('clients — the follow-up loop', () => {
  beforeEach(async () => { await resetDb(); });

  it('logging a call marks contact and schedules the next one from their cadence', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Aurora Tech Salvage');
    await givePOs(id, MARCUS, [10, 40, 70], 4000);   // tier A here, 14-day cadence

    const before = await api<Client>('GET', `/api/suppliers/${id}`, { token: marcus.token });
    const cadence = before.body.cadenceDays;

    const r = await api<{ nextFollowUpAt: string }>('POST', `/api/suppliers/${id}/notes`, {
      token: marcus.token, body: { kind: 'call', body: 'Has a 40-unit R740 pull in two weeks.' },
    });
    expect(r.status).toBe(200);

    const expected = new Date(Date.now() + cadence * 86_400_000).toISOString().slice(0, 10);
    expect(r.body.nextFollowUpAt).toBe(expected);

    const after = await api<Client & { timeline: { kind: string; body: string; author: string }[] }>(
      'GET', `/api/suppliers/${id}`, { token: marcus.token });
    expect(after.body.lastContactedAt).not.toBeNull();
    expect(after.body.nextFollowUpAt).toBe(expected);
    expect(after.body.timeline[0].kind).toBe('call');
    expect(after.body.timeline[0].body).toMatch(/R740/);
  });

  it('an explicit date beats the automatic one', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Boulder Server Exchange');
    const r = await api<{ nextFollowUpAt: string }>('POST', `/api/suppliers/${id}/notes`, {
      token: marcus.token, body: { kind: 'text', nextFollowUpAt: '2026-12-24' } });
    expect(r.body.nextFollowUpAt).toBe('2026-12-24');
  });

  it('a logged call with no typed note still says something on the timeline', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Westside Computer Recycling');
    await api('POST', `/api/suppliers/${id}/notes`, { token: marcus.token, body: { kind: 'call' } });
    const d = await api<{ timeline: { body: string }[] }>('GET', `/api/suppliers/${id}`,
      { token: marcus.token });
    expect(d.body.timeline[0].body).toBe('Called');
  });

  it('rejects a contact kind nobody defined', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Cheyenne Mountain Surplus');
    const r = await api('POST', `/api/suppliers/${id}/notes`, {
      token: marcus.token, body: { kind: 'telepathy' } });
    expect(r.status).toBe(400);
  });

  it('counts overdue separately from what is merely coming up', async () => {
    const marcus = await loginAs(MARCUS);
    const late = await mkClient(marcus.token, 'Late Co');
    const soon = await mkClient(marcus.token, 'Soon Co');
    const later = await mkClient(marcus.token, 'Later Co');
    await api('PATCH', `/api/suppliers/${late}`, { token: marcus.token, body: { nextFollowUpAt: '2020-01-01' } });
    const in3 = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const in90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    await api('PATCH', `/api/suppliers/${soon}`, { token: marcus.token, body: { nextFollowUpAt: in3 } });
    await api('PATCH', `/api/suppliers/${later}`, { token: marcus.token, body: { nextFollowUpAt: in90 } });

    const all = await api<ListBody>('GET', '/api/suppliers', { token: marcus.token });
    expect(all.body.counts.due).toBe(1);
    expect(all.body.counts.soon).toBe(1);

    const due = await api<ListBody>('GET', '/api/suppliers?follow=due', { token: marcus.token });
    expect(due.body.items.map((i) => i.name)).toEqual(['Late Co']);
  });

  it('lets the author delete their own note but not someone else\'s', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Typo Co');
    await api('POST', `/api/suppliers/${id}/notes`, { token: marcus.token, body: { kind: 'note', body: 'oops' } });
    const d = await api<{ timeline: { id: string }[] }>('GET', `/api/suppliers/${id}`, { token: marcus.token });
    const noteId = d.body.timeline[0].id;

    const priya = await loginAs(PRIYA);
    expect((await api('DELETE', `/api/suppliers/${id}/notes/${noteId}`, { token: priya.token })).status).toBe(404);
    expect((await api('DELETE', `/api/suppliers/${id}/notes/${noteId}`, { token: marcus.token })).status).toBe(200);
  });
});

describe('clients — the detail payload', () => {
  beforeEach(async () => { await resetDb(); });

  it("keeps the client's own note separate from the contact log", async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Two Notes Co', { notes: 'Gate code 4417' });
    await api('POST', `/api/suppliers/${id}/notes`, {
      token: marcus.token, body: { kind: 'call', body: 'Spoke about a pallet' } });

    const d = await api<{ notes: unknown; timeline: { body: string }[] }>(
      'GET', `/api/suppliers/${id}`, { token: marcus.token });
    // `notes` must stay the free-text string the purchaser typed. It was being
    // overwritten by the log array, which then crashed the drawer's render.
    expect(d.body.notes).toBe('Gate code 4417');
    expect(Array.isArray(d.body.timeline)).toBe(true);
    expect(d.body.timeline[0].body).toBe('Spoke about a pallet');
  });
});

describe('clients — building the book', () => {
  beforeEach(async () => { await resetDb(); });

  it('clears a field back to empty (COALESCE would silently ignore this)', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Clearable Co', { prefPayment: 'Zelle' });
    await api('PATCH', `/api/suppliers/${id}`, { token: marcus.token, body: { prefPayment: null } });
    const d = await api<{ preferences: { payment: string | null } }>(
      'GET', `/api/suppliers/${id}`, { token: marcus.token });
    expect(d.body.preferences.payment).toBeNull();
  });

  it('does not let /suggestions or /adopt be swallowed by /:id', async () => {
    const marcus = await loginAs(MARCUS);
    const s = await api<{ items: unknown[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    expect(s.status).toBe(200);
    expect(Array.isArray(s.body.items)).toBe(true);
    // /:id would 404 on the literal word; a 400 proves /adopt matched.
    const a = await api('POST', '/api/suppliers/adopt', { token: marcus.token, body: {} });
    expect(a.status).toBe(400);
  });

  it('requires a name and nothing else', async () => {
    const marcus = await loginAs(MARCUS);
    expect((await api('POST', '/api/suppliers', { token: marcus.token, body: {} })).status).toBe(400);
    expect((await api('POST', '/api/suppliers', { token: marcus.token, body: { name: 'Kevin' } })).status).toBe(201);
  });

  it('validates before the database does, so a bad value is a 400 not a 500', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Validated Co');
    for (const body of [
      { email: 'not-an-email' },
      { status: 'banished' },
      { cadenceDays: 9999 },
      { supplies: [1, 2, 3] },
    ]) {
      const r = await api('PATCH', `/api/suppliers/${id}`, { token: marcus.token, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('every endpoint refuses an anonymous caller', async () => {
    expect((await api('GET', '/api/suppliers')).status).toBe(401);
    expect((await api('GET', '/api/suppliers/suggestions')).status).toBe(401);
    expect((await api('POST', '/api/suppliers', { body: { name: 'x' } })).status).toBe(401);
  });
});

describe('clients — reassignment', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager moves a book and the handover lands on the timeline', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const id = await mkClient(marcus.token, 'Handover Co');

    expect((await api('POST', `/api/suppliers/${id}/reassign`, {
      token: marcus.token, body: { ownerId: priya.user.id } })).status).toBe(403);

    const boss = await loginAs(ALEX);
    expect((await api('POST', `/api/suppliers/${id}/reassign`, {
      token: boss.token, body: { ownerId: priya.user.id } })).status).toBe(200);

    expect((await api('GET', `/api/suppliers/${id}`, { token: marcus.token })).status).toBe(404);
    const now = await api<Client & { timeline: { kind: string; body: string }[] }>(
      'GET', `/api/suppliers/${id}`, { token: priya.token });
    expect(now.status).toBe(200);
    expect(now.body.timeline[0].kind).toBe('owner_changed');
    expect(now.body.timeline[0].body).toMatch(/to Priya/i);
  });

  it('sends a departing purchaser\'s client to house accounts, not nowhere', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await mkClient(marcus.token, 'Orphan Co');
    const boss = await loginAs(ALEX);
    expect((await api('POST', `/api/suppliers/${id}/reassign`, {
      token: boss.token, body: { ownerId: null } })).status).toBe(200);
    const seen = await api<ListBody>('GET', '/api/suppliers', { token: boss.token });
    const row = seen.body.items.find((i) => i.name === 'Orphan Co')!;
    expect(row.ownerId).toBeNull();
    expect(row.ownerName).toBeNull();
  });
});
