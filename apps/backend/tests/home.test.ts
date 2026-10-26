import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { orderFingerprint } from '../src/services/sellOrderSignoff';

// GET /api/home — what waits on the viewer. Scoping follows effectiveRole,
// and every manager count must agree with the page its tile opens.

type PurchaserHome = {
  role: 'purchaser';
  purchaser: {
    stages: Record<string, number>;
    openPos: { count: number; items: { id: string; lifecycle: string; since: string; blockers?: string[] }[] };
    packages: { moving: number; needs: number; items: { id: string }[] };
    commission: { owed: number; owedCount: number; paidRecent: number };
    followUps: { due: number; soon: number };
  };
  manager?: unknown;
};

type ManagerHome = {
  role: 'manager';
  manager: {
    inbound: { moving: number; needs: number; arriving: number; pickups: number };
    review: { count: number; items: { id: string }[] };
    readyToPay: { count: number; commission: number };
    signoffs: { count: number; items: { id: string }[] };
    bank: { unlinked: number; unlinkedAmount: number; disputes: number };
    rmb: { forMe: number; asked: number };
  };
  purchaser?: unknown;
};

async function createDraft(token: string, pn: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM', warehouseId: 'WH-LA1',
      lines: [{ category: 'RAM', partNumber: pn, condition: 'New', qty: 1, unitCost: 10 }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function createPackage(token: string, trackingNumber: string, status: string): Promise<string> {
  const r = await api<{ package: { id: string } }>('POST', '/api/packages', {
    token, body: { trackingNumber, carrier: 'UPS', source: 'other' },
  });
  expect(r.status).toBe(201);
  await getTestDb()`UPDATE packages SET status = ${status} WHERE id = ${r.body.package.id}`;
  return r.body.package.id;
}

describe('GET /api/home', () => {
  beforeEach(async () => { await resetDb(); });

  it('gives a purchaser only their own POs and packages, and no manager keys', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const mine = await createDraft(marcus.token, 'HOME-MINE-1');
    const theirs = await createDraft(priya.token, 'HOME-THEIRS-1');
    const myBox = await createPackage(marcus.token, 'HOMEPKG0001', 'in_transit');
    const theirBox = await createPackage(priya.token, 'HOMEPKG0002', 'exception');

    const r = await api<PurchaserHome>('GET', '/api/home', { token: marcus.token });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('purchaser');
    expect(r.body).not.toHaveProperty('manager');

    const sql = getTestDb();
    const [own] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM orders
      WHERE user_id = ${marcus.user.id} AND lifecycle = 'draft' AND archived_at IS NULL`;
    expect(r.body.purchaser.stages.draft).toBe(own.n);

    const ids = r.body.purchaser.openPos.items.map(i => i.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    // A draft carries the hand-off's own blocker list.
    const draft = r.body.purchaser.openPos.items.find(i => i.id === mine)!;
    expect(Array.isArray(draft.blockers)).toBe(true);

    const boxes = r.body.purchaser.packages.items.map(p => p.id);
    expect(boxes).toContain(myBox);
    expect(boxes).not.toContain(theirBox);
    const counts = await api<{ moving: number; needs: number }>(
      'GET', '/api/packages/inbound-counts?mine=true', { token: marcus.token });
    expect({ moving: r.body.purchaser.packages.moving, needs: r.body.purchaser.packages.needs })
      .toEqual(counts.body);
  });

  it('reads days in stage from the newest stage move', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await createDraft(marcus.token, 'HOME-AGE-1');
    const sql = getTestDb();
    await sql`UPDATE orders SET lifecycle = 'in_transit' WHERE id = ${id}`;
    // Out of the way of the seed's drafts, which list first.
    await sql`UPDATE orders SET archived_at = NOW() WHERE user_id = ${marcus.user.id} AND id <> ${id}`;
    await sql`
      INSERT INTO order_events (order_id, actor_id, kind, detail, created_at)
      VALUES (${id}, ${marcus.user.id}, 'submitted', '{}'::jsonb, NOW() - INTERVAL '5 days')`;

    const r = await api<PurchaserHome>('GET', '/api/home', { token: marcus.token });
    const row = r.body.purchaser.openPos.items.find(i => i.id === id)!;
    const days = (Date.now() - new Date(row.since).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(4.9);
    expect(days).toBeLessThan(5.1);
  });

  it('gives a manager previewing as a purchaser the purchaser Home', async () => {
    const alex = await loginAs(ALEX);
    const pref = await api('PATCH', '/api/me/preferences', {
      token: alex.token, body: { 'tweaks.rolePreview': 'as_purchaser' },
    });
    expect(pref.status).toBe(200);
    const r = await api<PurchaserHome>('GET', '/api/home', { token: alex.token });
    expect(r.body.role).toBe('purchaser');
    expect(r.body).not.toHaveProperty('manager');
  });

  it('agrees with the counts the linked pages show', async () => {
    const marcus = await loginAs(MARCUS);
    await createPackage(marcus.token, 'HOMEPKG0003', 'purchased');
    await createPackage(marcus.token, 'HOMEPKG0004', 'exception');
    const alex = await loginAs(ALEX);

    const r = await api<ManagerHome>('GET', '/api/home', { token: alex.token });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('manager');
    expect(r.body).not.toHaveProperty('purchaser');
    const m = r.body.manager;

    const inbound = await api<{ moving: number; needs: number }>('GET', '/api/packages/inbound-counts', { token: alex.token });
    expect({ moving: m.inbound.moving, needs: m.inbound.needs }).toEqual(inbound.body);

    const rmb = await api<{ forMe: number; asked: number }>('GET', '/api/accounting/review/count', { token: alex.token });
    expect(m.rmb).toEqual(rmb.body);

    const bank = await api<{ unlinked: { count: number; amount: number } }>(
      'GET', '/api/bank-transactions/stats?direction=out', { token: alex.token });
    expect(m.bank.unlinked).toBe(bank.body.unlinked.count);
    expect(m.bank.unlinkedAmount).toBeCloseTo(bank.body.unlinked.amount, 2);

    const [rev] = await getTestDb()<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM orders WHERE lifecycle = 'reviewing' AND archived_at IS NULL`;
    expect(m.review.count).toBe(rev.n);
  });

  it('lists a sell order for sign-off until this manager signs it as it stands', async () => {
    const sql = getTestDb();
    const [so] = await sql<{ id: string }[]>`
      SELECT id FROM sell_orders WHERE archived_at IS NULL ORDER BY id LIMIT 1`;
    expect(so).toBeDefined();
    await sql`UPDATE sell_orders SET status = 'Awaiting payment' WHERE id = ${so.id}`;
    await sql`DELETE FROM sell_order_signoffs WHERE sell_order_id = ${so.id}`;
    const alex = await loginAs(ALEX);

    const before = await api<ManagerHome>('GET', '/api/home', { token: alex.token });
    expect(before.body.manager.signoffs.items.map(i => i.id)).toContain(so.id);

    const fp = (await orderFingerprint(sql, so.id))!;
    await sql`
      INSERT INTO sell_order_signoffs (sell_order_id, user_id, fingerprint)
      VALUES (${so.id}, ${alex.user.id}, ${fp})`;
    const after = await api<ManagerHome>('GET', '/api/home', { token: alex.token });
    expect(after.body.manager.signoffs.items.map(i => i.id)).not.toContain(so.id);

    // An edit since voids the sign-off, and the order is back on the list.
    await sql`UPDATE sell_order_signoffs SET fingerprint = 'stale' WHERE sell_order_id = ${so.id}`;
    const stale = await api<ManagerHome>('GET', '/api/home', { token: alex.token });
    expect(stale.body.manager.signoffs.items.map(i => i.id)).toContain(so.id);
  });
});
