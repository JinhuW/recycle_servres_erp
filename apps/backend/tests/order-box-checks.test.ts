// Box check: a manager counting a PO against the box that arrived. Progress
// and flags are stored per line and never move the stage.

import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const PN = 'BOXCHECK-PN';

type Checks = {
  lines: {
    lineId: string; counted: number; flagReason: string | null; flagNote: string | null;
    checkedAt: string | null; flagSentAt: string | null;
  }[];
  extras: { id: string; partNumber: string; note: string | null; sentAt: string | null }[];
};

async function createDraft(pur: string): Promise<string> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001',
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [
        { category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5 },
        { category: 'RAM', brand: 'Samsung', capacity: '16GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN + '-B', condition: 'Pulled — Tested', qty: 2, unitCost: 40 },
      ],
    },
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function createReviewing(pur: string, mgr: string): Promise<{ id: string; lineIds: string[] }> {
  const id = await createDraft(pur);
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } })).status).toBe(200);
  const got = await api<{ order: { lines: { id: string }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
  return { id, lineIds: got.body.order.lines.map(l => l.id) };
}

describe('box check', () => {
  let pur: string;
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    pur = (await loginAs(MARCUS)).token;
    mgr = (await loginAs(ALEX)).token;
  });

  it('saves counts per line and stamps checkedAt only at the full qty', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const [a, b] = lineIds as [string, string];

    const empty = await api<Checks>('GET', `/api/orders/${id}/checks`, { token: mgr });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ lines: [], extras: [] });

    const part = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 2 } });
    expect(part.status).toBe(200);
    expect(part.body.lines.find(l => l.lineId === a)).toMatchObject({ counted: 2, checkedAt: null });

    const full = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 4 } });
    const stamped = full.body.lines.find(l => l.lineId === a)!.checkedAt;
    expect(stamped).not.toBeNull();

    // A recount that stays full keeps its place in the Checked group.
    const again = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 4 } });
    expect(again.body.lines.find(l => l.lineId === a)!.checkedAt).toBe(stamped);

    const flagged = await api<Checks>('PUT', `/api/orders/${id}/checks/${b}`, {
      token: mgr, body: { counted: 1, flagReason: 'short', flagNote: '  one missing  ' },
    });
    expect(flagged.body.lines.find(l => l.lineId === b)).toMatchObject({ counted: 1, flagReason: 'short', flagNote: 'one missing' });

    // Reads never touch the PO's own qty or stage.
    const order = await api<{ order: { lifecycle: string; lines: { id: string; qty: number }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
    expect(order.body.order.lifecycle).toBe('reviewing');
    expect(order.body.order.lines.find(l => l.id === b)!.qty).toBe(2);
  });

  it('takes checked as its own answer, apart from the count', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const a = lineIds[0]!;
    const put = (body: unknown) => api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body });
    const row = (r: { body: Checks }) => r.body.lines.find(l => l.lineId === a)!;

    // The count starts full; a full count left unticked is not checked.
    expect(row(await put({ counted: 4, checked: false })).checkedAt).toBeNull();
    const ticked = row(await put({ counted: 4, checked: true }));
    expect(ticked.checkedAt).not.toBeNull();
    // Re-sending the tick keeps its place in the Checked group.
    expect(row(await put({ counted: 4, checked: true })).checkedAt).toBe(ticked.checkedAt);
    // Unticking keeps the count.
    expect(row(await put({ counted: 4, checked: false }))).toMatchObject({ counted: 4, checkedAt: null });
    expect((await put({ counted: 4, checked: 'yes' })).status).toBe(400);
  });

  it('reads a body with no checked field the way the first bundle meant it', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const a = lineIds[0]!;
    const r = await api<Checks>('PUT', `/api/orders/${id}/checks/${a}`, { token: mgr, body: { counted: 4 } });
    expect(r.body.lines.find(l => l.lineId === a)!.checkedAt).not.toBeNull();
  });

  it('keeps reads off the PO itself', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const b = lineIds[1]!;
    await api('PUT', `/api/orders/${id}/checks/${b}`, { token: mgr, body: { counted: 1, checked: false, flagReason: 'short' } });
    const order = await api<{ order: { lifecycle: string; lines: { id: string; qty: number }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
    expect(order.body.order.lifecycle).toBe('reviewing');
    expect(order.body.order.lines.find(l => l.id === b)!.qty).toBe(2);
  });

  it('refuses a purchaser, and lets a manager previewing as purchaser through (raw role)', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('GET', `/api/orders/${id}/checks`, { token: pur })).status).toBe(403);
    expect((await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: pur, body: { counted: 1 } })).status).toBe(403);

    expect((await api('PATCH', '/api/me/preferences', { token: mgr, body: { 'tweaks.rolePreview': 'as_purchaser' } })).status).toBe(200);
    expect((await api('GET', `/api/orders/${id}/checks`, { token: mgr })).status).toBe(200);
  });

  it('validates the line, the count and the reason', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    const other = await createReviewing(pur, mgr);
    const put = (lineId: string, body: unknown) => api('PUT', `/api/orders/${id}/checks/${lineId}`, { token: mgr, body });

    expect((await put(other.lineIds[0]!, { counted: 1 })).status).toBe(404);
    expect((await put('not-a-uuid', { counted: 1 })).status).toBe(404);
    expect((await put(lineIds[0]!, { counted: 5 })).status).toBe(400);
    expect((await put(lineIds[0]!, { counted: -1 })).status).toBe(400);
    expect((await put(lineIds[0]!, { counted: 1.5 })).status).toBe(400);
    expect((await put(lineIds[0]!, { counted: 1, flagReason: 'stolen' })).status).toBe(400);
    expect((await api('GET', '/api/orders/PO-NOPE/checks', { token: mgr })).status).toBe(404);
  });

  it('refuses writes on an archived PO but still reads', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr, body: {} })).status).toBe(200);
    expect((await api('GET', `/api/orders/${id}/checks`, { token: mgr })).status).toBe(200);
    expect((await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: mgr, body: { counted: 1 } })).status).toBe(409);
  });

  it('drops a line\'s check with the line', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr);
    await api('PUT', `/api/orders/${id}/checks/${lineIds[0]}`, { token: mgr, body: { counted: 2 } });
    const sql = getTestDb();
    await sql`DELETE FROM order_lines WHERE id = ${lineIds[0]!}`;
    const after = await api<Checks>('GET', `/api/orders/${id}/checks`, { token: mgr });
    expect(after.body.lines).toEqual([]);
  });
});

// Review mode moves a PO to Reviewing, and its Approve to Ready to Pay, with an
// absolute `toStage`: both name the stage they saw, and review mode asks for
// the hand-off's facts on a Draft it jumps past In Transit.
describe('advance preconditions used by review mode', () => {
  let pur: string;
  let mgr: string;
  let purId: string;
  beforeEach(async () => {
    await resetDb();
    const p = await loginAs(MARCUS);
    pur = p.token;
    purId = p.user.id;
    mgr = (await loginAs(ALEX)).token;
  });

  type Refusal = { error: string; code?: string; lifecycle?: string };
  const lifecycleOf = async (id: string) =>
    (await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${id}`, { token: mgr })).body.order.lifecycle;
  const eventCount = async (id: string) =>
    (await api<{ events: unknown[] }>('GET', `/api/orders/${id}/events`, { token: mgr })).body.events.length;

  it('refuses a move from a stage the order has left, before anything is written', async () => {
    const { id } = await createReviewing(pur, mgr);
    expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'ready_to_pay' } })).status).toBe(200);
    const before = await eventCount(id);

    const stale = await api<Refusal>('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'reviewing', fromStage: 'in_transit' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'stageMoved', lifecycle: 'ready_to_pay' });
    expect(await lifecycleOf(id)).toBe('ready_to_pay');
    expect(await eventCount(id)).toBe(before);
  });

  it('checks the precondition ahead of the same-stage refusal', async () => {
    const { id } = await createReviewing(pur, mgr);
    const r = await api<Refusal>('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'reviewing', fromStage: 'in_transit' },
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'stageMoved', lifecycle: 'reviewing' });
  });

  it('moves when the order is where the caller saw it', async () => {
    const { id } = await createReviewing(pur, mgr);
    const r = await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'ready_to_pay', fromStage: 'reviewing' },
    });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(id)).toBe('ready_to_pay');
  });

  it("holds a Draft to the hand-off's facts only when asked to", async () => {
    const strict = await createDraft(pur);
    const refused = await api<Refusal>('POST', `/api/orders/${strict}/advance`, {
      token: mgr, body: { toStage: 'reviewing', fromStage: 'draft', enforce: 'all' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/where this order came from/);
    expect(await lifecycleOf(strict)).toBe('draft');

    // With the facts on file the same request goes through.
    await getTestDb()`
      UPDATE orders SET source = 'facebook', handoff_method = 'pickup', handoff_by = ${purId},
                        payment_method = 'paypal'
      WHERE id = ${strict}`;
    const moved = await api('POST', `/api/orders/${strict}/advance`, {
      token: mgr, body: { toStage: 'reviewing', fromStage: 'draft', enforce: 'all' },
    });
    expect(moved.status).toBe(200);
    expect(await lifecycleOf(strict)).toBe('reviewing');

    // Unasked, a manager's jump still skips them, so an old Draft is never stuck.
    const lax = await createDraft(pur);
    const jumped = await api('POST', `/api/orders/${lax}/advance`, { token: mgr, body: { toStage: 'reviewing' } });
    expect(jumped.status).toBe(200);
  });
});
