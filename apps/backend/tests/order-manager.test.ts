// The manager of a PO: set by the manager who takes it into review, and
// changed only when another manager moving it answers "make me the manager".
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS, type LoginResult } from './helpers/auth';

const migration = (file: string) => readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations', file),
  'utf8',
);
const MIGRATION = migration('0156_order_manager.sql');
const BACKFILL_PAST_REVIEW = migration('0158_order_manager_backfill_past_review.sql');

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [{ category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40 }],
};

type Manager = { id: string; name: string } | null;
type OrderBody = { lifecycle: string; manager: Manager; lines: { id: string }[] };
type AnyEvent = { kind: string; detail: { to?: string } };
type Event = { kind: string; detail: { fromUserId?: string | null; from?: string | null; toUserId?: string; to?: string } };

async function getOrder(token: string, id: string): Promise<OrderBody> {
  const r = await api<{ order: OrderBody }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order;
}

async function managerEvents(token: string, id: string): Promise<Event[]> {
  const r = await api<{ events: Event[] }>('GET', `/api/orders/${id}/events`, { token });
  expect(r.status).toBe(200);
  return r.body.events.filter(e => e.kind === 'manager_changed');
}

async function advance(token: string, id: string, body: Record<string, unknown> = {}) {
  return api<{ lifecycle?: string; error?: string; code?: string; manager?: Manager }>(
    'POST', `/api/orders/${id}/advance`, { token, body });
}

let marcus: LoginResult;
let alex: LoginResult;
let sofia: LoginResult;

// A PO owned by Marcus, submitted to In Transit.
async function inTransit(): Promise<string> {
  const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
  expect(created.status).toBe(201);
  expect((await advance(marcus.token, created.body.id)).status).toBe(200);
  return created.body.id;
}

// ... and moved into Reviewing by Alex, which makes Alex its manager.
async function reviewedByAlex(): Promise<string> {
  const id = await inTransit();
  expect((await advance(alex.token, id)).body.lifecycle).toBe('reviewing');
  return id;
}

describe('the manager of a PO', () => {
  beforeEach(async () => {
    await resetDb();
    marcus = await loginAs(MARCUS);
    alex = await loginAs(ALEX);
    sofia = await loginAs(SOFIA);
  });

  it('is the manager who moves the PO into Reviewing', async () => {
    const id = await inTransit();
    expect((await getOrder(alex.token, id)).manager).toBeNull();

    expect((await advance(alex.token, id)).status).toBe(200);
    expect((await getOrder(alex.token, id)).manager).toEqual({ id: alex.user.id, name: expect.any(String) });

    const evs = await managerEvents(alex.token, id);
    expect(evs).toHaveLength(1);
    expect(evs[0].detail).toMatchObject({ fromUserId: null, from: null, toUserId: alex.user.id });
  });

  it('stays when another manager moves the PO without taking it over', async () => {
    const id = await reviewedByAlex();

    expect((await advance(sofia.token, id)).body.lifecycle).toBe('ready_to_pay');
    expect((await getOrder(sofia.token, id)).manager?.id).toBe(alex.user.id);
    expect(await managerEvents(sofia.token, id)).toHaveLength(1);
  });

  it('goes to the manager who moves the PO and takes it over', async () => {
    const id = await reviewedByAlex();

    expect((await advance(sofia.token, id, { takeManager: true })).body.lifecycle).toBe('ready_to_pay');
    expect((await getOrder(sofia.token, id)).manager?.id).toBe(sofia.user.id);

    const evs = await managerEvents(sofia.token, id);
    expect(evs).toHaveLength(2);
    expect(evs.find(e => e.detail.fromUserId === alex.user.id)?.detail)
      .toMatchObject({ toUserId: sofia.user.id });

    // Taking over an order that is already yours writes nothing.
    expect((await advance(sofia.token, id, { takeManager: true })).body.lifecycle).toBe('done');
    expect(await managerEvents(sofia.token, id)).toHaveLength(2);
  });

  it('is not taken over by a move the server refuses', async () => {
    const id = await reviewedByAlex();

    const r = await advance(sofia.token, id, { toStage: 'ready_to_pay', fromStage: 'in_transit', takeManager: true });
    expect(r.status).toBe(409);
    expect((await getOrder(sofia.token, id)).manager?.id).toBe(alex.user.id);
  });

  it('is never a purchaser, whatever the purchaser sends', async () => {
    const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
    const id = created.body.id;

    expect((await advance(marcus.token, id, { takeManager: true })).body.lifecycle).toBe('in_transit');
    expect((await getOrder(marcus.token, id)).manager).toBeNull();
    expect(await managerEvents(marcus.token, id)).toHaveLength(0);
  });

  it('is the manager who jumps a PO past Reviewing with nobody on it', async () => {
    const id = await inTransit();

    expect((await advance(sofia.token, id, { toStage: 'ready_to_pay' })).body.lifecycle).toBe('ready_to_pay');
    expect((await getOrder(sofia.token, id)).manager?.id).toBe(sofia.user.id);
  });

  it('survives a purchaser edit that sends the PO back to Draft', async () => {
    const id = await reviewedByAlex();
    const lineId = (await getOrder(marcus.token, id)).lines[0].id;

    const patched = await api('PATCH', `/api/orders/${id}`, {
      token: marcus.token, body: { lines: [{ id: lineId, unitCost: 1 }] },
    });
    expect(patched.status).toBe(200);
    const after = await getOrder(alex.token, id);
    expect(after.lifecycle).toBe('draft');
    expect(after.manager?.id).toBe(alex.user.id);
  });

  it('refuses a move from a page that saw a different manager, and moves nothing', async () => {
    const id = await reviewedByAlex();

    const r = await advance(sofia.token, id, { fromManagerId: null });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('managerChanged');
    expect(r.body.manager).toEqual({ id: alex.user.id, name: expect.any(String) });
    const after = await getOrder(sofia.token, id);
    expect(after.lifecycle).toBe('reviewing');
    expect(after.manager?.id).toBe(alex.user.id);
    expect(await managerEvents(sofia.token, id)).toHaveLength(1);

    expect((await advance(sofia.token, id, { fromManagerId: alex.user.id })).body.lifecycle).toBe('ready_to_pay');
  });

  it("ignores the manager a purchaser's page saw", async () => {
    const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
    const id = created.body.id;
    await getTestDb()`UPDATE orders SET manager_id = ${alex.user.id} WHERE id = ${id}`;

    expect((await advance(marcus.token, id, { fromManagerId: null })).body.lifecycle).toBe('in_transit');
  });

  it.each([
    ['demoted', { role: 'purchaser' }],
    ['deactivated', { active: false }],
  ])('stops being the manager once %s, and the next mover is stamped', async (_, change) => {
    const id = await reviewedByAlex();
    const sql = getTestDb();
    await sql`UPDATE users SET ${sql(change)} WHERE id = ${alex.user.id}`;

    expect((await getOrder(sofia.token, id)).manager).toBeNull();
    const list = await api<{ orders: { id: string; manager: Manager }[] }>('GET', '/api/orders', { token: sofia.token });
    expect(list.body.orders.find(o => o.id === id)?.manager).toBeNull();

    // Sofia's page shows nobody, so nobody is asked about.
    expect((await advance(sofia.token, id, { fromManagerId: null })).body.lifecycle).toBe('ready_to_pay');
    expect((await getOrder(sofia.token, id)).manager?.id).toBe(sofia.user.id);
    const evs = await managerEvents(sofia.token, id);
    expect(evs).toHaveLength(2);
    expect(evs[1].detail).toMatchObject({ fromUserId: alex.user.id, toUserId: sofia.user.id });
    expect(evs[1].detail.from).toEqual(expect.any(String));
  });

  it('logs the takeover after the move that made it', async () => {
    // Three POs: on a shared NOW() each pair would land in random order.
    for (let i = 0; i < 3; i++) {
      const id = await reviewedByAlex();
      expect((await advance(sofia.token, id, { takeManager: true })).status).toBe(200);
      const r = await api<{ events: AnyEvent[] }>('GET', `/api/orders/${id}/events`, { token: sofia.token });
      const kinds = r.body.events
        .filter(e => e.kind === 'manager_changed' || (e.kind === 'advanced' && e.detail.to !== 'in_transit'))
        .map(e => (e.kind === 'advanced' ? `advanced:${e.detail.to}` : e.kind));
      expect(kinds).toEqual([
        'advanced:reviewing', 'manager_changed', 'advanced:ready_to_pay', 'manager_changed',
      ]);
    }
  });

  it('is shown to the purchaser in the detail, the list and the activity log', async () => {
    const id = await reviewedByAlex();

    expect((await getOrder(marcus.token, id)).manager?.id).toBe(alex.user.id);

    const list = await api<{ orders: { id: string; manager: Manager }[] }>('GET', '/api/orders', { token: marcus.token });
    expect(list.status).toBe(200);
    expect(list.body.orders.find(o => o.id === id)?.manager?.id).toBe(alex.user.id);

    expect(await managerEvents(marcus.token, id)).toHaveLength(1);
  });
});

describe('0156 — the manager from history', () => {
  beforeEach(async () => { await resetDb(); });

  it('names the manager who last moved each PO into Reviewing, if still a manager', async () => {
    marcus = await loginAs(MARCUS);
    alex = await loginAs(ALEX);
    sofia = await loginAs(SOFIA);
    const sql = getTestDb();
    const toSofia = await reviewedByAlex();
    const toNobody = await reviewedByAlex();

    // A later move into Reviewing by Sofia outranks Alex's; on the other PO
    // the last mover has since stopped being a manager.
    await sql`UPDATE orders SET manager_id = NULL WHERE id IN ${sql([toSofia, toNobody])}`;
    await sql`
      INSERT INTO order_events (order_id, actor_id, kind, detail, created_at)
      VALUES (${toSofia}, ${sofia.user.id}, 'advanced', ${sql.json({ from: 'in_transit', to: 'reviewing' })},
              now() + interval '1 minute')`;
    await sql`
      INSERT INTO order_events (order_id, actor_id, kind, detail, created_at)
      VALUES (${toNobody}, ${marcus.user.id}, 'advanced', ${sql.json({ from: 'in_transit', to: 'reviewing' })},
              now() + interval '1 minute')`;

    await sql.unsafe(MIGRATION);

    const rows = await sql<{ id: string; manager_id: string | null }[]>`
      SELECT id, manager_id FROM orders WHERE id IN ${sql([toSofia, toNobody])}`;
    expect(rows.find(r => r.id === toSofia)?.manager_id).toBe(sofia.user.id);
    expect(rows.find(r => r.id === toNobody)?.manager_id).toBeNull();
  });
});

describe('0158 — the manager from moves past Reviewing', () => {
  beforeEach(async () => { await resetDb(); });

  it('names the manager who last moved each PO into a managed stage, if still a manager', async () => {
    marcus = await loginAs(MARCUS);
    alex = await loginAs(ALEX);
    sofia = await loginAs(SOFIA);
    const sql = getTestDb();

    // Jumped straight to Ready to Pay: 0156 found no move into Reviewing.
    const jumped = await inTransit();
    expect((await advance(sofia.token, jumped, { toStage: 'ready_to_pay' })).status).toBe(200);
    // The latest managed move is by someone who isn't a manager; Alex's,
    // before it, still names the manager.
    const shadowed = await reviewedByAlex();
    // Already has one: left alone.
    const kept = await reviewedByAlex();
    // Never moved past In Transit: nothing to name.
    const never = await inTransit();

    await sql`UPDATE orders SET manager_id = NULL WHERE id IN ${sql([jumped, shadowed, never])}`;
    await sql`
      INSERT INTO order_events (order_id, actor_id, kind, detail, created_at)
      VALUES (${shadowed}, ${marcus.user.id}, 'advanced', ${sql.json({ from: 'reviewing', to: 'done' })},
              now() + interval '1 minute'),
             (${kept}, ${sofia.user.id}, 'advanced', ${sql.json({ from: 'reviewing', to: 'ready_to_pay' })},
              now() + interval '1 minute')`;

    await sql.unsafe(BACKFILL_PAST_REVIEW);

    const rows = await sql<{ id: string; manager_id: string | null }[]>`
      SELECT id, manager_id FROM orders WHERE id IN ${sql([jumped, shadowed, kept, never])}`;
    const managerOf = (id: string) => rows.find(r => r.id === id)?.manager_id;
    expect(managerOf(jumped)).toBe(sofia.user.id);
    expect(managerOf(shadowed)).toBe(alex.user.id);
    expect(managerOf(kept)).toBe(alex.user.id);
    expect(managerOf(never)).toBeNull();
  });
});
