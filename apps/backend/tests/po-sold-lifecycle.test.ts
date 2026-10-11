// Sold beside the stage: a PO from In Transit on whose every line with units
// is at line status Sold carries a `sold` flag, derived from the lines on read
// (services/orderSold.ts). It is never a lifecycle, never written, and only
// managers are told it.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { firstCustomerId, signOffAll } from './helpers/fixtures';

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [
    { category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40, partNumber: 'PN-A' },
    { category: 'RAM', qty: 1, unitCost: 10, condition: 'New', sellPrice: 40, partNumber: 'PN-B' },
  ],
};

type Order = {
  id: string; lifecycle: string; status: string; sold?: boolean;
  lines: { id: string; status: string; qty: number }[];
};
type Row = { id: string; lifecycle: string; status: string; sold?: boolean };
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

async function listRows(token: string, qs: string): Promise<Row[]> {
  const r = await api<{ orders: Row[] }>('GET', `/api/orders${qs}`, { token });
  expect(r.status).toBe(200);
  return r.body.orders;
}
const listIds = async (token: string, qs: string) => (await listRows(token, qs)).map(o => o.id);

type Stage = 'draft' | 'in_transit' | 'reviewing' | 'ready_to_pay' | 'done';
const STAGES: Stage[] = ['draft', 'in_transit', 'reviewing', 'ready_to_pay', 'done'];

// A two-line PO owned by Marcus, driven by Alex to the requested stage.
async function orderAt(stage: Stage) {
  const marcus = await loginAs(MARCUS);
  const alex = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
  expect(created.status).toBe(201);
  const id = created.body.id;
  for (let i = 0; i < STAGES.indexOf(stage); i++) {
    expect((await advance(i === 0 ? marcus.token : alex.token, id)).status).toBe(200);
  }
  const lines = (await getOrder(alex.token, id)).lines;
  return { id, marcus, alex, lines };
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
  await signOffAll(soId);
  const done = await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } });
  expect(done.status).toBe(200);
  return soId;
}

// A Done PO sold out line by line, as it happens in production.
async function soldOrder() {
  const o = await orderAt('done');
  for (const l of o.lines) await sellDone(o.alex.token, l.id, l.qty);
  const order = await getOrder(o.alex.token, o.id);
  expect(order).toMatchObject({ lifecycle: 'done', sold: true });
  return o;
}

describe('sold is a flag beside the stage', () => {
  beforeEach(async () => { await resetDb(); });

  it('holds at every stage from In Transit on, never at Draft, and leaves the stage alone', async () => {
    const db = getTestDb();
    for (const stage of STAGES) {
      const { id, alex } = await orderAt(stage);
      // However the lines got there: the flag reads them, not how they moved.
      await db`UPDATE order_lines SET status = 'Sold' WHERE order_id = ${id}`;
      const order = await getOrder(alex.token, id);
      expect(order.lifecycle).toBe(stage);
      expect(order.sold).toBe(stage !== 'draft');
      const row = (await listRows(alex.token, '')).find(o => o.id === id);
      expect(row).toMatchObject({ lifecycle: stage, sold: stage !== 'draft' });
    }
  });

  it('a PO that sells out at Ready to Pay is sold there, and stays sold onto Done with no settle row', async () => {
    const { id, alex, lines } = await orderAt('ready_to_pay');
    for (const l of lines) await sellDone(alex.token, l.id, l.qty);
    expect(await getOrder(alex.token, id)).toMatchObject({ lifecycle: 'ready_to_pay', status: 'Ready to Pay', sold: true });

    const r = await advance(alex.token, id);
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('done');
    expect(await getOrder(alex.token, id)).toMatchObject({ lifecycle: 'done', status: 'Done', sold: true });
    expect(advances(await events(alex.token, id)).join(' ')).not.toMatch(/sold/);
  });

  it('a partial sale is not sold', async () => {
    const { id, alex, lines } = await orderAt('done');
    await sellDone(alex.token, lines[1].id, 1);
    await sellDone(alex.token, lines[0].id, 1);
    expect((await getOrder(alex.token, id)).sold).toBe(false);
  });

  // A line counted down to 0 in review never arrived: nothing of it can sell,
  // so it must not keep the PO from reading sold.
  it('a line counted down to 0 does not count', async () => {
    const { id, alex } = await orderAt('reviewing');
    const [sold, never] = (await getOrder(alex.token, id)).lines;
    const zero = await api('PATCH', `/api/orders/${id}`, {
      token: alex.token, body: { lines: [{ id: never.id, qty: 0 }] },
    });
    expect(zero.status).toBe(200);
    await sellDone(alex.token, sold.id, sold.qty);
    const order = await getOrder(alex.token, id);
    expect(order).toMatchObject({ lifecycle: 'reviewing', sold: true });
    expect(order.lines.find(l => l.id === never.id)).toMatchObject({ qty: 0 });
  });

  it('walking a line off Sold clears it, with nothing to reopen first', async () => {
    const { id, alex, lines } = await soldOrder();
    const r = await api('PATCH', `/api/inventory/${lines[0].id}`, { token: alex.token, body: { status: 'Done' } });
    expect(r.status).toBe(200);
    expect(await getOrder(alex.token, id)).toMatchObject({ lifecycle: 'done', sold: false });
  });

  it('hand-setting the last unsold line to Sold makes it sold', async () => {
    const { id, alex, lines } = await orderAt('done');
    await sellDone(alex.token, lines[0].id, 2);
    expect((await api('PATCH', `/api/inventory/${lines[1].id}`, { token: alex.token, body: { status: 'Sold' } })).status).toBe(200);
    expect((await getOrder(alex.token, id)).sold).toBe(true);
  });

  it('is not a stage a manager can jump to', async () => {
    const { id, alex } = await soldOrder();
    const r = await advance(alex.token, id, 'sold');
    expect(r.status).toBe(400);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('done');
  });

  it('a reopen keeps it: the stage moves, the lines stay Sold', async () => {
    const { id, alex } = await soldOrder();
    expect((await advance(alex.token, id, 'reviewing')).status).toBe(200);
    expect(await getOrder(alex.token, id)).toMatchObject({ lifecycle: 'reviewing', sold: true });
  });

  it('archive is orthogonal: an archived sold PO still filters as Sold', async () => {
    const { id, alex } = await soldOrder();
    expect((await api('POST', `/api/orders/${id}/archive`, { token: alex.token })).status).toBe(200);
    expect(await listIds(alex.token, '?includeArchived=true&status=Sold')).toContain(id);
  });
});

describe('the list filters', () => {
  beforeEach(async () => { await resetDb(); });

  it('for a manager: Done finds a sold Done PO, Sold finds every sold PO, and either can be excluded', async () => {
    const done = await soldOrder();
    const rtp = await orderAt('ready_to_pay');
    for (const l of rtp.lines) await sellDone(rtp.alex.token, l.id, l.qty);
    const plain = await orderAt('done');
    const t = done.alex.token;

    expect(await listIds(t, '?status=Done')).toEqual(expect.arrayContaining([done.id, plain.id]));
    expect(await listIds(t, '?status=Done')).not.toContain(rtp.id);
    const sold = await listIds(t, '?status=Sold');
    expect(sold).toEqual(expect.arrayContaining([done.id, rtp.id]));
    expect(sold).not.toContain(plain.id);

    // The phone's default view: a sold PO short of Done is still on the plate.
    const active = await listIds(t, '?excludeStatus=Done');
    expect(active).toContain(rtp.id);
    expect(active).not.toContain(done.id);
    expect(await listIds(t, '?excludeStatus=Sold')).toEqual(expect.arrayContaining([plain.id]));
    expect(await listIds(t, '?excludeStatus=Sold')).not.toContain(rtp.id);
  });
});

describe('purchasers are never told', () => {
  beforeEach(async () => { await resetDb(); });

  it('detail and list carry no flag; Done finds the PO and Sold finds nothing', async () => {
    const { id, marcus } = await soldOrder();
    const detail = await getOrder(marcus.token, id);
    expect(detail.status).toBe('Done');
    expect('sold' in detail).toBe(false);
    const row = (await listRows(marcus.token, '')).find(o => o.id === id);
    expect(row && 'sold' in row).toBe(false);

    expect(await listIds(marcus.token, '?status=Done')).toContain(id);
    expect(await listIds(marcus.token, '?status=Sold')).toEqual([]);
  });

  it('a manager previewing as a purchaser is not told either', async () => {
    const alex = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/orders', { token: alex.token, body: BODY });
    const id = created.body.id;
    for (let i = 0; i < 4; i++) expect((await advance(alex.token, id)).status).toBe(200);
    for (const l of (await getOrder(alex.token, id)).lines) await sellDone(alex.token, l.id, l.qty);
    expect((await getOrder(alex.token, id)).sold).toBe(true);

    const pref = await api('PATCH', '/api/me/preferences', { token: alex.token, body: { 'tweaks.rolePreview': 'as_purchaser' } });
    expect(pref.status).toBe(200);
    expect('sold' in await getOrder(alex.token, id)).toBe(false);
    expect(await listIds(alex.token, '?status=Sold')).toEqual([]);
  });
});

describe('a sold PO counts as Done for the dashboard', () => {
  beforeEach(async () => { await resetDb(); });

  it('the purchaser KPIs and the leaderboard include it', async () => {
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

// The migration runs before the seed when a worker builds its template, so the
// test replays the real file over data it makes.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const M0173 = readFileSync(join(MIGRATIONS, '0173_po_sold_is_a_flag.sql'), 'utf8');

describe('0173 — the sold lifecycle goes back to done', () => {
  beforeEach(async () => { await resetDb(); });

  it('moves sold POs to done, idempotently, and the old settle history reads in today\'s terms', async () => {
    const db = getTestDb();
    const { id, alex } = await soldOrder();
    // Where the old settle path, and a reopen from it, left a PO.
    await db`UPDATE orders SET lifecycle = 'sold' WHERE id = ${id}`;
    await db`INSERT INTO order_events (order_id, actor_id, kind, detail) VALUES
      (${id}, NULL, 'advanced', '{"from":"done","to":"sold"}'::jsonb),
      (${id}, NULL, 'advanced', '{"from":"sold","to":"reviewing"}'::jsonb)`;

    await db.unsafe(M0173);
    await db.unsafe(M0173);
    expect(await getOrder(alex.token, id)).toMatchObject({ lifecycle: 'done', status: 'Done', sold: true });

    const moves = advances(await events(alex.token, id));
    expect(moves).not.toContain('done>sold');
    expect(moves).toContain('done>reviewing');
    expect(moves.join(' ')).not.toMatch(/sold/);
  });
});
