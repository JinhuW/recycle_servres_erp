// A manager-only figure is left out of a non-manager's JSON, never sent as
// null: the key alone would name a feature the caller isn't meant to know
// exists. "Non-manager" is the effective role, so a manager previewing as
// purchaser gets the purchaser shape too — except on whole-endpoint 403s,
// which gate on the real role (the preview is a viewing convenience).

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const PN = 'SHAPE-TEST-PN';

type Line = { id: string; status: string };
type Detail = { order: { lines: Line[]; pendingRevert?: unknown } };
type Conflict = { error: string; offendingLineIds?: string[]; sellOrderIds?: string[] };

async function createSubmitted(pur: string): Promise<{ id: string; lineIds: string[] }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001',
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [
        { category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5 },
        { category: 'RAM', brand: 'Samsung', capacity: '16GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 2, unitCost: 40 },
      ],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  const got = await api<Detail>('GET', `/api/orders/${id}`, { token: pur });
  return { id, lineIds: got.body.order.lines.map(l => l.id) };
}

async function createReviewing(pur: string, mgr: string): Promise<{ id: string; lineIds: string[] }> {
  const po = await createSubmitted(pur);
  expect((await api('POST', `/api/orders/${po.id}/advance`, {
    token: mgr, body: { toStage: 'reviewing' },
  })).status).toBe(200);
  return po;
}

async function createSellOrderOn(mgr: string, lineId: string): Promise<string> {
  const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token: mgr });
  const so = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: mgr,
    body: {
      customerId: customers.body.items[0].id,
      lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: PN, qty: 1, unitPrice: 90 }],
    },
  });
  expect(so.status).toBe(201);
  return so.body.id;
}

async function setPreview(token: string, mode: 'as_purchaser' | 'actual'): Promise<void> {
  const r = await api('PATCH', '/api/me/preferences', { token, body: { 'tweaks.rolePreview': mode } });
  expect(r.status).toBe(200);
}

describe('GET /api/orders — linkedPaid', () => {
  beforeEach(async () => { await resetDb(); });

  it('is absent for a purchaser and for a manager previewing as purchaser, present for a manager', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id } = await createSubmitted(pur);
    type Row = { id: string; linkedPaid?: number | null };
    const rowFor = async (token: string, poId: string) => {
      const r = await api<{ orders: Row[] }>('GET', '/api/orders', { token });
      expect(r.status).toBe(200);
      const row = r.body.orders.find(o => o.id === poId);
      expect(row).toBeDefined();
      return row!;
    };

    expect(await rowFor(pur, id)).not.toHaveProperty('linkedPaid');

    const asManager = await rowFor(mgr, id);
    expect(asManager).toHaveProperty('linkedPaid');
    expect(asManager.linkedPaid).toBeNull();   // nothing linked yet

    // Preview scopes the list to the manager's own POs, so read one of those.
    const own = await createSubmitted(mgr);
    await setPreview(mgr, 'as_purchaser');
    expect(await rowFor(mgr, own.id)).not.toHaveProperty('linkedPaid');
  });
});

describe('GET /api/orders/:id — pendingRevert', () => {
  beforeEach(async () => { await resetDb(); });

  it('is absent for the purchaser and for a preview manager, an array for a manager', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createSubmitted(pur);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ id: lineIds[0], unitCost: 1 }] },
    })).status).toBe(200);
    const get = (token: string) => api<Detail>('GET', `/api/orders/${id}`, { token });

    expect((await get(pur)).body.order).not.toHaveProperty('pendingRevert');
    expect((await get(mgr)).body.order.pendingRevert).toHaveLength(1);

    // Preview scopes reads to the manager's own POs; a manager's own PO
    // carries an empty array, and in preview no key at all.
    const own = await createSubmitted(mgr);
    const getOwn = () => api<Detail>('GET', `/api/orders/${own.id}`, { token: mgr });
    expect((await getOwn()).body.order.pendingRevert).toEqual([]);
    await setPreview(mgr, 'as_purchaser');
    expect((await getOwn()).body.order).not.toHaveProperty('pendingRevert');
  });
});

describe('GET /api/orders/:id/events — archived.removedSellOrderLines', () => {
  beforeEach(async () => { await resetDb(); });

  it('is absent for the owner and for a preview manager, a count for a manager', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    await createSellOrderOn(mgr, lineIds[0]);
    expect((await api('POST', `/api/orders/${id}/archive`, {
      token: mgr, body: { removeFromSellOrders: true },
    })).status).toBe(200);

    type Ev = { kind: string; detail: Record<string, unknown> };
    const archivedFor = async (token: string, poId: string) => {
      const r = await api<{ events: Ev[] }>('GET', `/api/orders/${poId}/events`, { token });
      expect(r.status).toBe(200);
      const ev = r.body.events.find(e => e.kind === 'archived');
      expect(ev).toBeDefined();
      return ev!.detail;
    };

    expect(await archivedFor(mgr, id)).toHaveProperty('removedSellOrderLines', 1);
    const forOwner = await archivedFor(pur, id);
    expect(forOwner).not.toHaveProperty('removedSellOrderLines');
    expect(forOwner).toHaveProperty('lines', 2);   // the rest of the event survives the strip

    // Preview scopes reads to the manager's own POs: archive one of those the
    // same way, then read its log in preview.
    const own = await createReviewing(mgr, mgr);
    await createSellOrderOn(mgr, own.lineIds[0]);
    expect((await api('POST', `/api/orders/${own.id}/archive`, {
      token: mgr, body: { removeFromSellOrders: true },
    })).status).toBe(200);
    expect(await archivedFor(mgr, own.id)).toHaveProperty('removedSellOrderLines', 1);
    await setPreview(mgr, 'as_purchaser');
    const inPreview = await archivedFor(mgr, own.id);
    expect(inPreview).not.toHaveProperty('removedSellOrderLines');
    expect(inPreview).toHaveProperty('lines', 2);
  });
});

describe('PATCH /api/orders/:id — sell-order conflict body', () => {
  beforeEach(async () => { await resetDb(); });

  it('names no sell order to the purchaser whose edit is refused', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);

    const blocked = await api<Conflict>('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ id: lineIds[0], qty: 6 }] },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.offendingLineIds).toContain(lineIds[0]);
    expect(blocked.body).not.toHaveProperty('sellOrderIds');
    expect(blocked.body.error).not.toContain(soId);
  });

  it('names the sell order to a manager removing the line, but not in preview', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);
    const remove = () => api<Conflict>('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { removeLineIds: [lineIds[0]] },
    });

    const asManager = await remove();
    expect(asManager.status).toBe(409);
    expect(asManager.body.sellOrderIds).toEqual([soId]);
    expect(asManager.body.error).toContain(soId);

    await setPreview(mgr, 'as_purchaser');
    const inPreview = await remove();
    expect(inPreview.status).toBe(409);
    expect(inPreview.body.offendingLineIds).toEqual([lineIds[0]]);
    expect(inPreview.body).not.toHaveProperty('sellOrderIds');
    expect(inPreview.body.error).not.toContain(soId);
  });
});

describe('GET /api/dashboard — leaderboard money', () => {
  beforeEach(async () => { await resetDb(); });

  const MONEY = ['email', 'cost', 'revenue', 'profit', 'commission'] as const;
  type Row = { id: string } & Partial<Record<typeof MONEY[number], unknown>>;
  const rows = async (token: string) => {
    const r = await api<{ leaderboard: Row[] }>('GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    expect(r.body.leaderboard.length).toBeGreaterThan(1);
    return r.body.leaderboard;
  };

  it('a purchaser gets the five keys on their own row only', async () => {
    const { token, user } = await loginAs(MARCUS);
    for (const row of await rows(token)) {
      for (const k of MONEY) {
        if (row.id === user.id) expect(row).toHaveProperty(k);
        else expect(row).not.toHaveProperty(k);
      }
    }
  });

  it('a manager gets them on every row; in preview on none', async () => {
    const { token } = await loginAs(ALEX);
    for (const row of await rows(token)) for (const k of MONEY) expect(row).toHaveProperty(k);

    await setPreview(token, 'as_purchaser');
    // A manager has no row of their own — the board lists purchasers.
    for (const row of await rows(token)) for (const k of MONEY) expect(row).not.toHaveProperty(k);
  });
});

describe('GET /api/warehouses — manager contact', () => {
  beforeEach(async () => { await resetDb(); });

  it('managerPhone/managerEmail are absent for a purchaser and a preview manager, present for a manager', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const mgr = await loginAs(ALEX);
    expect((await api('PATCH', '/api/warehouses/WH-HK', {
      token: mgr.token, body: { managerUserId: mgr.user.id },
    })).status).toBe(200);
    type Wh = { id: string; manager?: string | null; managerEmail?: string | null; managerPhone?: string | null };
    const hk = async (token: string) => {
      const r = await api<{ items: Wh[] }>('GET', '/api/warehouses', { token });
      expect(r.status).toBe(200);
      return r.body.items.find(w => w.id === 'WH-HK')!;
    };

    const asManager = await hk(mgr.token);
    expect(asManager.managerEmail).toBe(mgr.user.email);
    expect(asManager).toHaveProperty('managerPhone');

    const asPurchaser = await hk(pur);
    expect(asPurchaser).not.toHaveProperty('managerEmail');
    expect(asPurchaser).not.toHaveProperty('managerPhone');
    expect(asPurchaser.manager).toBeTruthy();   // the name stays

    await setPreview(mgr.token, 'as_purchaser');
    const inPreview = await hk(mgr.token);
    expect(inPreview).not.toHaveProperty('managerEmail');
    expect(inPreview).not.toHaveProperty('managerPhone');
  });
});

describe('GET /api/inventory/:id/sell-orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('403s a purchaser — the line owner included — and answers a manager, previewing or not', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);
    const list = (token: string) =>
      api<{ items: { id: string }[] }>('GET', `/api/inventory/${lineIds[0]}/sell-orders`, { token });

    expect((await list(pur)).status).toBe(403);

    const asManager = await list(mgr);
    expect(asManager.status).toBe(200);
    expect(asManager.body.items.map(i => i.id)).toEqual([soId]);

    // Whole-endpoint 403s gate on the real role: the preview is a viewing
    // convenience, and the page this feeds is already bounced in preview.
    await setPreview(mgr, 'as_purchaser');
    expect((await list(mgr)).status).toBe(200);
  });
});

describe('PATCH /api/orders/:id and /handoff — paymentsLinked', () => {
  beforeEach(async () => { await resetDb(); });

  it('is absent for a purchaser and a preview manager, a count for a manager', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id } = await createSubmitted(pur);
    const save = (token: string, poId: string) =>
      api<{ ok: boolean; paymentsLinked?: number }>('PATCH', `/api/orders/${poId}`, { token, body: { notes: 'shape' } });

    const asPurchaser = await save(pur, id);
    expect(asPurchaser.status).toBe(200);
    expect(asPurchaser.body).not.toHaveProperty('paymentsLinked');

    const asManager = await save(mgr, id);
    expect(asManager.status).toBe(200);
    expect(asManager.body.paymentsLinked).toBe(0);

    const own = await createSubmitted(mgr);
    await setPreview(mgr, 'as_purchaser');
    const inPreview = await save(mgr, own.id);
    expect(inPreview.status).toBe(200);
    expect(inPreview.body).not.toHaveProperty('paymentsLinked');
  });
});

describe('POST /api/orders/:id/advance — sell-order conflict body', () => {
  beforeEach(async () => { await resetDb(); });

  // Only a manager can move a PO backwards, so the plain body is reachable
  // only by a manager previewing as purchaser — the refusal still has to
  // agree with the PATCH one for the same caller.
  it('names the sell order to a manager, but not in preview', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(mgr, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0]);
    const back = () => api<Conflict>('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'in_transit' },
    });

    const asManager = await back();
    expect(asManager.status).toBe(409);
    expect(asManager.body.sellOrderIds).toEqual([soId]);
    expect(asManager.body.error).toContain(soId);

    await setPreview(mgr, 'as_purchaser');
    const inPreview = await back();
    expect(inPreview.status).toBe(409);
    expect(inPreview.body.offendingLineIds).toEqual([lineIds[0]]);
    expect(inPreview.body).not.toHaveProperty('sellOrderIds');
    expect(inPreview.body.error).not.toContain(soId);
    await setPreview(mgr, 'actual');
  });
});

describe('PATCH /api/warehouses/:id — manager contact', () => {
  beforeEach(async () => { await resetDb(); });

  it('the write response follows the same gate as the list', async () => {
    const mgr = await loginAs(ALEX);
    const link = () => api<{ id: string; managerEmail?: string | null; managerPhone?: string | null }>(
      'PATCH', '/api/warehouses/WH-HK', { token: mgr.token, body: { managerUserId: mgr.user.id } });

    const asManager = await link();
    expect(asManager.status).toBe(200);
    expect(asManager.body.managerEmail).toBe(mgr.user.email);

    await setPreview(mgr.token, 'as_purchaser');
    const inPreview = await link();
    expect(inPreview.status).toBe(200);
    expect(inPreview.body).not.toHaveProperty('managerEmail');
    expect(inPreview.body).not.toHaveProperty('managerPhone');
    await setPreview(mgr.token, 'actual');
  });
});
