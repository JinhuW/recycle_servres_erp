import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

// PO audit log — per-order activity stream that starts the moment a draft is
// submitted for review (Draft → In Transit) and captures every subsequent
// change: lifecycle advances, line edits, line add/remove, and meta changes.
//
// Why "after submit": drafts are throwaway scratch space; only the submitted
// snapshot and the changes a manager makes against it are accountability-
// relevant. The submitted event itself is the baseline (lineCount + totalCost).

type Ev = {
  id: string;
  kind: 'submitted' | 'advanced' | 'line_added' | 'line_removed' | 'line_edited' | 'meta_changed';
  actor: { id: string; name: string; initials: string } | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

async function createDraftWithLines(token: string) {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      warehouseId: 'WH-LA1',
      lines: [
        { category: 'RAM', partNumber: 'AUD-1', qty: 4, unitCost: 80, condition: 'Pulled — Tested' },
        { category: 'RAM', partNumber: 'AUD-2', qty: 2, unitCost: 50, condition: 'Pulled — Tested' },
      ],
    },
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function getEvents(orderId: string, token: string) {
  return api<{ events: Ev[] }>('GET', `/api/orders/${orderId}/events`, { token });
}

describe('PO audit log — lifecycle events', () => {
  beforeEach(async () => { await resetDb(); });

  it('writes a submitted event on Draft → In Transit', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createDraftWithLines(token);
    const adv = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(adv.status).toBe(200);

    const r = await getEvents(id, token);
    expect(r.status).toBe(200);
    const submitted = r.body.events.find(e => e.kind === 'submitted');
    expect(submitted, 'submitted event must be written on first advance').toBeDefined();
    expect(submitted!.detail).toMatchObject({ lineCount: 2 });
    expect(submitted!.actor?.name).toBeTruthy();
  });

  it('writes an advanced event on In Transit → Reviewing', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await createDraftWithLines(pTok);
    await api('POST', `/api/orders/${id}/advance`, { token: pTok });

    const { token: mTok } = await loginAs(ALEX);
    const r = await api('POST', `/api/orders/${id}/advance`, { token: mTok });
    expect(r.status).toBe(200);

    const events = (await getEvents(id, mTok)).body.events;
    const advanced = events.find(e => e.kind === 'advanced');
    expect(advanced, 'advanced event must be written for subsequent transitions').toBeDefined();
    expect(advanced!.detail).toMatchObject({ from: 'in_transit', to: 'reviewing' });
  });

  it('does NOT write events while the order is still a draft', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createDraftWithLines(token);

    // Edit while still draft — purchaser tweaking before submit.
    const patch = await api('PATCH', `/api/orders/${id}`, {
      token,
      body: { notes: 'tweaking before submit' },
    });
    expect(patch.status).toBe(200);

    const events = (await getEvents(id, token)).body.events;
    expect(events).toEqual([]);
  });
});

describe('PO audit log — PATCH change tracking', () => {
  beforeEach(async () => { await resetDb(); });

  async function submitted(token: string) {
    const id = await createDraftWithLines(token);
    await api('POST', `/api/orders/${id}/advance`, { token });
    return id;
  }

  it('writes a line_edited event with changes[] when manager re-prices a line', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await submitted(pTok);
    const { token: mTok } = await loginAs(ALEX);

    const detail = await api<{ order: { lines: { id: string; partNumber: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: mTok });
    const lineId = detail.body.order.lines.find(l => l.partNumber === 'AUD-1')!.id;

    const patch = await api('PATCH', `/api/orders/${id}`, {
      token: mTok,
      body: { lines: [{ id: lineId, sellPrice: 120, qty: 6 }] },
    });
    expect(patch.status).toBe(200);

    const events = (await getEvents(id, mTok)).body.events;
    const edits = events.filter(e => e.kind === 'line_edited');
    expect(edits.length).toBe(1);
    const changes = edits[0].detail.changes as { field: string; from: unknown; to: unknown }[];
    const fields = changes.map(c => c.field).sort();
    expect(fields).toEqual(['qty', 'sell_price']);
    const price = changes.find(c => c.field === 'sell_price')!;
    expect(price.from).toBeNull();
    expect(price.to).toBe(120);
    const qty = changes.find(c => c.field === 'qty')!;
    expect(qty.from).toBe(4);
    expect(qty.to).toBe(6);
  });

  it('writes a meta_changed event when manager sets commission rate', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await submitted(pTok);
    const { token: mTok } = await loginAs(ALEX);

    const patch = await api('PATCH', `/api/orders/${id}`, {
      token: mTok,
      body: { commissionRate: 0.1, notes: 'reviewed' },
    });
    expect(patch.status).toBe(200);

    const events = (await getEvents(id, mTok)).body.events;
    const meta = events.find(e => e.kind === 'meta_changed');
    expect(meta).toBeDefined();
    const changes = meta!.detail.changes as { field: string; from: unknown; to: unknown }[];
    const fields = changes.map(c => c.field).sort();
    expect(fields).toEqual(['commission_rate', 'notes']);
  });

  it('writes line_added and line_removed events on add/remove', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await submitted(pTok);
    const { token: mTok } = await loginAs(ALEX);

    const detail = await api<{ order: { lines: { id: string; partNumber: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: mTok });
    const removeId = detail.body.order.lines.find(l => l.partNumber === 'AUD-2')!.id;

    const patch = await api('PATCH', `/api/orders/${id}`, {
      token: mTok,
      body: {
        removeLineIds: [removeId],
        addLines: [{ category: 'RAM', partNumber: 'AUD-NEW', qty: 1, unitCost: 25, condition: 'New' }],
      },
    });
    expect(patch.status).toBe(200);

    const events = (await getEvents(id, mTok)).body.events;
    const added = events.find(e => e.kind === 'line_added');
    const removed = events.find(e => e.kind === 'line_removed');
    expect(added, 'line_added must be written').toBeDefined();
    expect(removed, 'line_removed must be written').toBeDefined();
    expect((added!.detail as { partNumber: string }).partNumber).toBe('AUD-NEW');
    expect((removed!.detail as { partNumber: string }).partNumber).toBe('AUD-2');
  });
});

describe('PO audit log — access control', () => {
  beforeEach(async () => { await resetDb(); });

  it('owner and manager can read; unrelated purchaser is forbidden', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await createDraftWithLines(pTok);
    await api('POST', `/api/orders/${id}/advance`, { token: pTok });

    const { token: mTok } = await loginAs(ALEX);
    const { token: otherTok } = await loginAs(PRIYA);

    expect((await getEvents(id, pTok)).status).toBe(200);
    expect((await getEvents(id, mTok)).status).toBe(200);
    expect((await getEvents(id, otherTok)).status).toBe(403);
  });

  it('order_events is append-only — direct UPDATE/DELETE raises', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createDraftWithLines(token);
    await api('POST', `/api/orders/${id}/advance`, { token });

    const db = getTestDb();
    await expect(db`DELETE FROM order_events WHERE order_id = ${id}`).rejects.toThrow();
    await expect(db`UPDATE order_events SET kind = 'tampered' WHERE order_id = ${id}`).rejects.toThrow();
  });
});
