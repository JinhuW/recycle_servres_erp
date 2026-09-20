// The 'sold' lifecycle: a Done PO whose every line has sold. Nobody picks it —
// services/orderSold.ts settles it inside the two transactions that can make
// the invariant true (a sell order reaching Done, the PO landing on Done), and
// purchasers are shown Done for it everywhere.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [
    { category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40, partNumber: 'PN-A' },
    { category: 'RAM', qty: 1, unitCost: 10, condition: 'New', sellPrice: 40, partNumber: 'PN-B' },
  ],
};

type Order = { id: string; lifecycle: string; status: string; lines: { id: string; status: string; qty: number }[] };
type Ev = { kind: string; detail: { from?: string; to?: string }; actor: { id: string } | null };

async function getOrder(token: string, id: string): Promise<Order> {
  const r = await api<{ order: Order }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order;
}

async function events(token: string, id: string): Promise<Ev[]> {
  const r = await api<{ events: Ev[] }>('GET', `/api/orders/${id}/events`, { token });
  expect(r.status).toBe(200);
  return r.body.events;
}

const advances = (evs: Ev[]) => evs.filter(e => e.kind === 'advanced').map(e => `${e.detail.from}>${e.detail.to}`);

async function advance(token: string, id: string, toStage?: string) {
  return api<{ lifecycle?: string; error?: string }>('POST', `/api/orders/${id}/advance`, {
    token, body: toStage ? { toStage } : {},
  });
}

async function listIds(token: string, qs: string): Promise<string[]> {
  const r = await api<{ orders: { id: string }[] }>('GET', `/api/orders${qs}`, { token });
  expect(r.status).toBe(200);
  return r.body.orders.map(o => o.id);
}

// A two-line PO owned by Marcus, driven by Alex to the requested stage.
async function orderAt(stage: 'ready_to_pay' | 'done') {
  const marcus = await loginAs(MARCUS);
  const alex = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await advance(marcus.token, id)).status).toBe(200);   // → in_transit
  expect((await advance(alex.token, id)).status).toBe(200);     // → reviewing
  expect((await advance(alex.token, id)).status).toBe(200);     // → ready_to_pay
  if (stage === 'done') expect((await advance(alex.token, id)).status).toBe(200);
  const lines = (await getOrder(alex.token, id)).lines;
  return { id, marcus, alex, lines };
}

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

// Raise a sell order for `qty` of `lineId` and drive it to Done.
async function sellDone(token: string, lineId: string, qty: number) {
  const customerId = await firstCustomerId(token);
  const create = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: { customerId, lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn', qty, unitPrice: 50 }] },
  });
  expect(create.status).toBe(201);
  const soId = create.body.id;
  await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Shipped', note: 's' } });
  await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Awaiting payment', note: 'a' } });
  const done = await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } });
  expect(done.status).toBe(200);
  return soId;
}

// A Done PO sold out line by line, as it happens in production.
async function soldOrder() {
  const o = await orderAt('done');
  for (const l of o.lines) await sellDone(o.alex.token, l.id, l.qty);
  expect((await getOrder(o.alex.token, o.id)).lifecycle).toBe('sold');
  return o;
}

describe('a sell order reaching Done settles a Done PO', () => {
  beforeEach(async () => { await resetDb(); });

  it('the last line to sell flips the PO to sold, with the settle row after the Done row and the seller as actor', async () => {
    const { id, alex, lines } = await orderAt('done');
    await sellDone(alex.token, lines[0].id, 2);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('done');

    await sellDone(alex.token, lines[1].id, 1);
    const order = await getOrder(alex.token, id);
    expect(order.lifecycle).toBe('sold');
    expect(order.status).toBe('Sold');
    expect(order.lines.every(l => l.status === 'Sold')).toBe(true);

    const evs = await events(alex.token, id);
    expect(advances(evs).slice(-2)).toEqual(['ready_to_pay>done', 'done>sold']);
    expect(evs.find(e => e.detail.to === 'sold')?.actor?.id).toBeDefined();
  });

  it('a partial sale leaves the PO at done', async () => {
    const { id, alex, lines } = await orderAt('done');
    await sellDone(alex.token, lines[1].id, 1);
    await sellDone(alex.token, lines[0].id, 1);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('done');
    expect(advances(await events(alex.token, id))).not.toContain('done>sold');
  });

  it('a fully sold PO still at Ready to Pay waits for Done, then lands on sold in that one step', async () => {
    const { id, alex, lines } = await orderAt('ready_to_pay');
    for (const l of lines) await sellDone(alex.token, l.id, l.qty);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('ready_to_pay');

    const r = await advance(alex.token, id);
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('sold');
    expect((await getOrder(alex.token, id)).lifecycle).toBe('sold');
    expect(advances(await events(alex.token, id)).slice(-2)).toEqual(['ready_to_pay>done', 'done>sold']);
  });
});

describe('sold is never chosen, and reopens like Done', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager stage-jump to sold is refused from done and from sold, writing nothing', async () => {
    const { id, alex } = await orderAt('done');
    const before = advances(await events(alex.token, id));
    const r = await advance(alex.token, id, 'sold');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/on its own/);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('done');
    expect(advances(await events(alex.token, id))).toEqual(before);

    const sold = await soldOrder();
    expect((await advance(sold.alex.token, sold.id, 'sold')).status).toBe(409);
  });

  it('at sold: a bodiless advance is the final stage, and Done is where it already is', async () => {
    const { id, alex } = await soldOrder();
    const before = advances(await events(alex.token, id));
    expect((await advance(alex.token, id)).status).toBe(409);
    const toDone = await advance(alex.token, id, 'done');
    expect(toDone.status).toBe(409);
    expect(toDone.body.error).toMatch(/reopen/i);
    expect(advances(await events(alex.token, id))).toEqual(before);
  });

  it('reopening to Reviewing keeps the lines Sold, and the way back to Done re-settles', async () => {
    const { id, alex } = await soldOrder();
    const r = await advance(alex.token, id, 'reviewing');
    expect(r.status).toBe(200);
    const reopened = await getOrder(alex.token, id);
    expect(reopened.lifecycle).toBe('reviewing');
    expect(reopened.lines.every(l => l.status === 'Sold')).toBe(true);

    expect((await advance(alex.token, id)).body.lifecycle).toBe('ready_to_pay');
    expect((await advance(alex.token, id)).body.lifecycle).toBe('sold');
    expect(advances(await events(alex.token, id)).slice(-4))
      .toEqual(['sold>reviewing', 'reviewing>ready_to_pay', 'ready_to_pay>done', 'done>sold']);
  });

  it('archive is orthogonal: a sold PO archives and unarchives as sold', async () => {
    const { id, alex } = await soldOrder();
    expect((await api('POST', `/api/orders/${id}/archive`, { token: alex.token })).status).toBe(200);
    const ids = await listIds(alex.token, '?includeArchived=true&status=Sold');
    expect(ids).toContain(id);
    expect((await api('POST', `/api/orders/${id}/unarchive`, { token: alex.token })).status).toBe(200);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('sold');
  });
});

describe('purchasers are shown Done', () => {
  beforeEach(async () => { await resetDb(); });

  it('list, detail and the activity feed read Done; the Done filter finds it and the Sold filter does not', async () => {
    const { id, marcus, alex } = await soldOrder();
    expect((await advance(alex.token, id, 'ready_to_pay')).status).toBe(200);  // a reopen from sold…
    expect((await advance(alex.token, id)).body.lifecycle).toBe('sold');        // …and back

    const detail = await getOrder(marcus.token, id);
    expect(detail.lifecycle).toBe('done');
    expect(detail.status).toBe('Done');

    expect(await listIds(marcus.token, '?status=Done')).toContain(id);
    expect(await listIds(marcus.token, '?status=Sold')).not.toContain(id);
    expect(await listIds(marcus.token, '?excludeStatus=Done')).not.toContain(id);

    const evs = await events(marcus.token, id);
    const moves = advances(evs);
    expect(moves.join(' ')).not.toMatch(/sold/);
    expect(moves).toContain('done>ready_to_pay');
    expect(moves.filter(m => m === 'ready_to_pay>done')).toHaveLength(2);
  });

  it('the manager sees Sold, and the phone default view hides it with Done', async () => {
    const { id, alex } = await soldOrder();
    expect(await listIds(alex.token, '?status=Sold')).toContain(id);
    expect(await listIds(alex.token, '?status=Done')).not.toContain(id);
    expect(await listIds(alex.token, '?excludeStatus=Done')).toContain(id);
    expect(await listIds(alex.token, '?excludeStatus=Done&excludeStatus=Sold')).not.toContain(id);
  });

  it('a manager previewing as a purchaser sees Done too', async () => {
    const alex = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/orders', { token: alex.token, body: BODY });
    const id = created.body.id;
    for (let i = 0; i < 4; i++) expect((await advance(alex.token, id)).status).toBe(200);
    for (const l of (await getOrder(alex.token, id)).lines) await sellDone(alex.token, l.id, l.qty);
    expect((await getOrder(alex.token, id)).status).toBe('Sold');

    const pref = await api('PATCH', '/api/me/preferences', { token: alex.token, body: { 'tweaks.rolePreview': 'as_purchaser' } });
    expect(pref.status).toBe(200);
    expect((await getOrder(alex.token, id)).status).toBe('Done');
    expect(await listIds(alex.token, '?status=Done')).toContain(id);
  });
});

describe('sold counts as Done for the dashboard', () => {
  beforeEach(async () => { await resetDb(); });

  it('the purchaser KPIs and the leaderboard include a sold PO', async () => {
    const { id, marcus, alex } = await soldOrder();
    const db = getTestDb();
    await db`UPDATE orders SET created_at = NOW() - INTERVAL '400 days' WHERE id <> ${id}`;

    const mine = await api<{ kpis: { count: number; cost: number } }>('GET', '/api/dashboard?range=30d', { token: marcus.token });
    expect(mine.status).toBe(200);
    expect(mine.body.kpis.count).toBe(1);
    expect(mine.body.kpis.cost).toBeGreaterThan(0);

    const lb = await api<{ leaderboard: { name: string; count: number; cost: number }[] }>(
      'GET', '/api/dashboard?range=30d', { token: alex.token });
    const row = lb.body.leaderboard.find(r => r.count > 0);
    expect(row?.count).toBe(1);
    expect(row?.cost).toBeGreaterThan(0);
  });
});

describe('the inventory editor and the invariant', () => {
  beforeEach(async () => { await resetDb(); });

  it('a Sold line under a sold PO cannot be walked back; after a reopen it can, and Done then stays Done', async () => {
    const { id, alex, lines } = await soldOrder();
    const locked = await api<{ error: string }>('PATCH', `/api/inventory/${lines[0].id}`, { token: alex.token, body: { status: 'Done' } });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatch(/fully sold/);

    expect((await advance(alex.token, id, 'ready_to_pay')).status).toBe(200);
    expect((await api('PATCH', `/api/inventory/${lines[0].id}`, { token: alex.token, body: { status: 'Done' } })).status).toBe(200);
    expect((await advance(alex.token, id)).body.lifecycle).toBe('done');
  });

  it('hand-setting the last unsold line to Sold settles the PO', async () => {
    const { id, alex, lines } = await orderAt('done');
    await sellDone(alex.token, lines[0].id, 2);
    expect((await api('PATCH', `/api/inventory/${lines[1].id}`, { token: alex.token, body: { status: 'Sold' } })).status).toBe(200);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('sold');
  });
});

// The migration runs before the seed when a worker builds its template, so the
// test replays the real file over data it makes.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const M0130 = readFileSync(join(MIGRATIONS, '0130_po_sold_lifecycle.sql'), 'utf8');

describe('0130 — backfilling Done POs that had already sold out', () => {
  beforeEach(async () => { await resetDb(); });

  it('flips sold-out Done POs (archived too) with a system audit row, leaves the rest, and is idempotent', async () => {
    const db = getTestDb();
    const soldOut = await soldOrder();
    const partial = await orderAt('done');
    await sellDone(partial.alex.token, partial.lines[0].id, 2);
    // Put the sold-out PO back where a pre-rule deploy would have left it.
    await db`UPDATE orders SET lifecycle = 'done', archived_at = NOW() WHERE id = ${soldOut.id}`;
    // A Done PO with no lines at all has nothing sold, so it is not sold.
    const owner = (await db<{ user_id: string }[]>`SELECT user_id FROM orders WHERE id = ${soldOut.id}`)[0].user_id;
    await db`INSERT INTO orders (id, user_id, category, lifecycle) VALUES ('PO-EMPTY-DONE', ${owner}, 'RAM', 'done')`;

    await db.unsafe(M0130);
    const lc = async (id: string) => (await db<{ lifecycle: string }[]>`SELECT lifecycle FROM orders WHERE id = ${id}`)[0].lifecycle;
    expect(await lc(soldOut.id)).toBe('sold');
    expect(await lc(partial.id)).toBe('done');
    expect(await lc('PO-EMPTY-DONE')).toBe('done');

    const rows = await db<{ actor_id: string | null }[]>`
      SELECT actor_id FROM order_events
      WHERE order_id = ${soldOut.id} AND kind = 'advanced' AND detail->>'to' = 'sold'
      ORDER BY created_at`;
    expect(rows.at(-1)?.actor_id).toBeNull();
    const n = rows.length;

    await db.unsafe(M0130);
    const again = await db<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM order_events WHERE order_id = ${soldOut.id} AND detail->>'to' = 'sold'`;
    expect(again[0].c).toBe(n);
  });
});
