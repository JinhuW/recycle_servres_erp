import { beforeEach, describe, it, expect } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { firstCustomerId } from './helpers/fixtures';

type Line = { id: string; qty: number; label: string };
type Detail = {
  case: {
    id: string; status: string; resolution: string | null; amount: number | null; closedAt: string | null;
    assignee: { id: string; name: string } | null;
    lines: { sellOrderLineId: string | null; qty: number; label: string }[];
    events: { kind: string; from: string | null; to: string | null; note: string | null; actor: { name: string } | null }[];
    allowedTo: string[];
  };
};

async function newSellOrder(token: string, qty = 3): Promise<{ id: string; lines: Line[] }> {
  const line = await freeSellableLine(token, qty);
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty, unitPrice: line.sell_price }] },
  });
  expect(r.status).toBe(201);
  const got = await api<{ order: { lines: Line[] } }>('GET', `/api/sell-orders/${r.body.id}`, { token });
  return { id: r.body.id, lines: got.body.order.lines };
}

async function shippedOrder(token: string, qty = 3): Promise<{ id: string; lines: Line[] }> {
  const so = await newSellOrder(token, qty);
  const r = await api('POST', `/api/sell-orders/${so.id}/status`, { token, body: { to: 'Shipped', note: 'ship' } });
  expect(r.status).toBe(200);
  return so;
}

async function openCase(token: string, so: { id: string; lines: Line[] }, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/after-sales', {
    token,
    body: { sellOrderId: so.id, issue: 'two sticks fail memtest', lines: [{ sellOrderLineId: so.lines[0].id, qty: 2 }], ...extra },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

const move = (token: string, id: string, to: string, note?: string) =>
  api<{ error?: string }>('POST', `/api/after-sales/${id}/status`, { token, body: { to, note } });

describe('after-sales cases', () => {
  beforeEach(async () => { await resetDb(); });

  it('is manager-only', async () => {
    const { token: pur } = await loginAs(MARCUS);
    expect((await api('GET', '/api/after-sales', { token: pur })).status).toBe(403);
    expect((await api('GET', '/api/after-sales/summary', { token: pur })).status).toBe(403);
    expect((await api('POST', '/api/after-sales', { token: pur, body: {} })).status).toBe(403);
    expect((await api('GET', '/api/after-sales', {})).status).toBe(401);
  });

  it('opens against a shipped order with AS- ids, snapshotting the lines', async () => {
    const { token } = await loginAs(ALEX);
    const so = await shippedOrder(token);
    const id = await openCase(token, so);
    expect(id).toMatch(/^AS-\d+$/);
    const got = await api<Detail>('GET', `/api/after-sales/${id}`, { token });
    expect(got.status).toBe(200);
    expect(got.body.case.status).toBe('Open');
    expect(got.body.case.lines).toMatchObject([{ sellOrderLineId: so.lines[0].id, qty: 2, label: 'x' }]);
    expect(got.body.case.events.map(e => e.kind)).toEqual(['created']);
    expect(got.body.case.events[0].actor?.name).toBeTruthy();
    expect(got.body.case.allowedTo).toEqual(['In progress', 'Awaiting return', 'Resolved', 'Cancelled']);

    const second = await openCase(token, so);
    expect(Number(second.slice(3))).toBe(Number(id.slice(3)) + 1);
  });

  it('refuses a Draft order, a missing order, a foreign line and too many units', async () => {
    const { token } = await loginAs(ALEX);
    const draft = await newSellOrder(token);
    const r = await api<{ error: string }>('POST', '/api/after-sales', {
      token, body: { sellOrderId: draft.id, issue: 'x', lines: [{ sellOrderLineId: draft.lines[0].id, qty: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Draft/);

    expect((await api('POST', '/api/after-sales', {
      token, body: { sellOrderId: 'SO-0', issue: 'x', lines: [{ sellOrderLineId: draft.lines[0].id, qty: 1 }] },
    })).status).toBe(404);

    const shipped = await shippedOrder(token);
    expect((await api('POST', '/api/after-sales', {
      token, body: { sellOrderId: shipped.id, issue: 'x', lines: [{ sellOrderLineId: draft.lines[0].id, qty: 1 }] },
    })).status).toBe(400);
    expect((await api('POST', '/api/after-sales', {
      token, body: { sellOrderId: shipped.id, issue: 'x', lines: [{ sellOrderLineId: shipped.lines[0].id, qty: 99 }] },
    })).status).toBe(400);
    expect((await api('POST', '/api/after-sales', {
      token, body: { sellOrderId: shipped.id, issue: '', lines: [{ sellOrderLineId: shipped.lines[0].id, qty: 1 }] },
    })).status).toBe(400);
  });

  it('walks Open → In progress → Awaiting return → Resolved, then reopens', async () => {
    const { token } = await loginAs(ALEX);
    const so = await shippedOrder(token);
    const id = await openCase(token, so);

    expect((await move(token, id, 'In progress', 'testing')).status).toBe(200);
    // A return has to be chosen before the goods can be awaited.
    const early = await move(token, id, 'Awaiting return');
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/Return/);
    expect((await api('PATCH', `/api/after-sales/${id}`, { token, body: { resolution: 'discount' } })).status).toBe(200);
    expect((await move(token, id, 'Awaiting return')).status).toBe(409);
    expect((await api('PATCH', `/api/after-sales/${id}`, { token, body: { resolution: 'return' } })).status).toBe(200);
    expect((await move(token, id, 'Awaiting return')).status).toBe(200);

    // Resolved needs the amount too.
    expect((await move(token, id, 'Resolved')).status).toBe(409);
    expect((await api('PATCH', `/api/after-sales/${id}`, { token, body: { amount: 150.5 } })).status).toBe(200);
    expect((await move(token, id, 'Resolved', 'refunded')).status).toBe(200);

    let got = await api<Detail>('GET', `/api/after-sales/${id}`, { token });
    expect(got.body.case.status).toBe('Resolved');
    expect(got.body.case.amount).toBe(150.5);
    expect(got.body.case.closedAt).not.toBeNull();
    expect(got.body.case.allowedTo).toEqual(['Open']);
    expect(got.body.case.events.map(e => [e.kind, e.from, e.to])).toEqual([
      ['created', null, 'Open'],
      ['status', 'Open', 'In progress'],
      ['edited', null, null],
      ['edited', null, null],
      ['status', 'In progress', 'Awaiting return'],
      ['edited', null, null],
      ['status', 'Awaiting return', 'Resolved'],
    ]);
    expect(got.body.case.events.at(-1)?.note).toBe('refunded');

    // Closed cases are read-only until reopened; the timeline still takes notes.
    const patch = await api<{ error: string }>('PATCH', `/api/after-sales/${id}`, { token, body: { issue: 'changed' } });
    expect(patch.status).toBe(409);
    expect((await api('POST', `/api/after-sales/${id}/notes`, { token, body: { note: 'customer thanked us' } })).status).toBe(200);
    expect((await move(token, id, 'In progress')).status).toBe(409);
    expect((await move(token, id, 'Open')).status).toBe(200);
    got = await api<Detail>('GET', `/api/after-sales/${id}`, { token });
    expect(got.body.case.status).toBe('Open');
    expect(got.body.case.closedAt).toBeNull();
    expect((await api('PATCH', `/api/after-sales/${id}`, { token, body: { issue: 'changed' } })).status).toBe(200);
  });

  it('keeps the Return resolution while the goods are awaited', async () => {
    const { token } = await loginAs(ALEX);
    const so = await shippedOrder(token);
    const id = await openCase(token, so, { resolution: 'return' });
    expect((await move(token, id, 'Awaiting return')).status).toBe(200);

    const patch = (body: Record<string, unknown>) =>
      api<{ error?: string }>('PATCH', `/api/after-sales/${id}`, { token, body });
    const discount = await patch({ resolution: 'discount' });
    expect(discount.status).toBe(409);
    expect(discount.body.error).toMatch(/Return/);
    expect((await patch({ resolution: '' })).status).toBe(409);
    // The page sends the resolution on every save: an unchanged Return passes.
    expect((await patch({ issue: 'one stick came back', resolution: 'return', amount: 20 })).status).toBe(200);
    expect((await patch({ assigneeId: null })).status).toBe(200);

    expect((await move(token, id, 'In progress')).status).toBe(200);
    expect((await patch({ resolution: 'discount' })).status).toBe(200);
    const got = await api<Detail>('GET', `/api/after-sales/${id}`, { token });
    expect(got.body.case.resolution).toBe('discount');
  });

  it('reads a blank move note as no note and refuses a bad one', async () => {
    const { token } = await loginAs(ALEX);
    const so = await shippedOrder(token);
    const id = await openCase(token, so);
    expect((await move(token, id, 'In progress', '   ')).status).toBe(200);
    const got = await api<Detail>('GET', `/api/after-sales/${id}`, { token });
    expect(got.body.case.events.at(-1)).toMatchObject({ kind: 'status', to: 'In progress', note: null });
    expect((await api('POST', `/api/after-sales/${id}/status`, { token, body: { to: 'Cancelled', note: 5 } })).status).toBe(400);
    expect((await move(token, id, 'Cancelled', 'x'.repeat(4001))).status).toBe(400);
  });

  it('cancels from any open stage and repeats a move harmlessly', async () => {
    const { token } = await loginAs(ALEX);
    const so = await shippedOrder(token);
    const id = await openCase(token, so);
    expect((await move(token, id, 'Cancelled')).status).toBe(200);
    expect((await move(token, id, 'Cancelled')).status).toBe(200);
    expect((await move(token, id, 'Nope')).status).toBe(400);
  });

  it('assigns only active managers', async () => {
    const { token } = await loginAs(ALEX);
    const { token: sofia } = await loginAs(SOFIA);
    const me = await api<{ user: { id: string } }>('GET', '/api/me', { token: sofia });
    const so = await shippedOrder(token);
    const id = await openCase(token, so, { assigneeId: me.body.user.id });
    const got = await api<Detail>('GET', `/api/after-sales/${id}`, { token });
    expect(got.body.case.assignee?.id).toBe(me.body.user.id);
    const marcus = await api<{ user: { id: string } }>('GET', '/api/me', { token: (await loginAs(MARCUS)).token });
    expect((await api('PATCH', `/api/after-sales/${id}`, { token, body: { assigneeId: marcus.body.user.id } })).status).toBe(400);
  });

  it('lists, searches, summarises and reads back by order', async () => {
    const { token } = await loginAs(ALEX);
    const so = await shippedOrder(token);
    const a = await openCase(token, so, { resolution: 'discount', amount: 40 });
    const b = await openCase(token, so);
    expect((await move(token, b, 'Resolved')).status).toBe(409);
    expect((await api('PATCH', `/api/after-sales/${b}`, { token, body: { resolution: 'discount', amount: 10 } })).status).toBe(200);
    expect((await move(token, b, 'Resolved')).status).toBe(200);

    type Row = { id: string; status: string; amount: number | null; lineCount: number; qty: number; sellOrder: { id: string } };
    const all = await api<{ rows: Row[]; nextCursor: string | null }>('GET', '/api/after-sales', { token });
    expect(all.status).toBe(200);
    expect(all.body.rows.map(r => r.id)).toEqual([b, a]);
    expect(all.body.rows[1]).toMatchObject({ amount: 40, lineCount: 1, qty: 2, sellOrder: { id: so.id } });

    const open = await api<{ rows: Row[] }>('GET', '/api/after-sales?status=Open', { token });
    expect(open.body.rows.map(r => r.id)).toEqual([a]);
    const byId = await api<{ rows: Row[] }>('GET', `/api/after-sales?q=${b}`, { token });
    expect(byId.body.rows.map(r => r.id)).toEqual([b]);
    const byIssue = await api<{ rows: Row[] }>('GET', '/api/after-sales?q=memtest', { token });
    expect(byIssue.body.rows).toHaveLength(2);
    expect((await api('GET', '/api/after-sales?status=Bogus', { token })).status).toBe(400);

    const sum = await api<{ byStatus: Record<string, { count: number; amount: number }> }>('GET', '/api/after-sales/summary', { token });
    expect(sum.body.byStatus.Open).toEqual({ count: 1, amount: 40 });
    expect(sum.body.byStatus.Resolved).toEqual({ count: 1, amount: 10 });
    expect(sum.body.byStatus.Cancelled).toEqual({ count: 0, amount: 0 });

    const forOrder = await api<{ cases: { id: string }[] }>('GET', `/api/after-sales/by-order/${so.id}`, { token });
    expect(forOrder.body.cases.map(c => c.id)).toEqual([b, a]);
  });

  it('keeps the snapshot when the sell order is edited and its lines rewritten', async () => {
    const { token } = await loginAs(ALEX);
    const so = await shippedOrder(token);
    const id = await openCase(token, so);
    const r = await api('PATCH', `/api/sell-orders/${so.id}`, { token, body: { notes: 'edited' } });
    expect(r.status).toBe(200);
    const got = await api<Detail>('GET', `/api/after-sales/${id}`, { token });
    expect(got.body.case.lines[0]).toMatchObject({ qty: 2, label: 'x' });
  });
});
