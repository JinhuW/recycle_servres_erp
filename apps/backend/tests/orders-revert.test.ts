// The manager-facing half of the purchaser-edit revert: what the `reverted`
// event records, and the pending/acknowledged handshake that drives the
// "what changed" dialog.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type AuditChange = { field: string; from: unknown; to: unknown };
type RevertDetail = {
  from: string;
  to: string;
  fields: AuditChange[];
  lines: {
    added: { lineId: string; partNumber: string | null; qty: number; unitCost: number }[];
    removed: { lineId: string; partNumber: string | null; qty: number; unitCost: number }[];
    edited: { lineId: string; partNumber: string | null; changes: AuditChange[] }[];
  };
};
type PendingRevert = {
  id: string;
  createdAt: string;
  actor: { id: string; name: string; initials: string } | null;
  detail: RevertDetail;
};
type OrderDetail = {
  order: {
    lifecycle: string;
    lines: { id: string; partNumber: string | null }[];
    pendingRevert?: PendingRevert[] | null;
  };
};

async function createSubmitted(pur: string): Promise<{ id: string; lineId: string }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
        condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
      }],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  const got = await api<OrderDetail>('GET', `/api/orders/${id}`, { token: pur });
  return { id, lineId: got.body.order.lines[0].id };
}

const get = (id: string, token: string) => api<OrderDetail>('GET', `/api/orders/${id}`, { token });

describe('reverted event — change payload', () => {
  beforeEach(async () => { await resetDb(); });

  it('records the order fields and every line change that caused the revert', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);

    const patched = await api<{ addedLineIds: string[] }>('PATCH', `/api/orders/${id}`, {
      token: pur,
      body: {
        otherFees: 250,
        lines: [{ id: lineId, qty: 8 }],
        addLines: [{
          category: 'RAM', brand: 'Hynix', capacity: '16GB', type: 'DDR4',
          partNumber: 'HMA82GR7CJR8N', condition: 'New', qty: 2, unitCost: 40,
        }],
      },
    });
    expect(patched.status).toBe(200);
    const addedId = patched.body.addedLineIds[0];

    const pending = (await get(id, mgr)).body.order.pendingRevert!;
    expect(pending).toHaveLength(1);
    const d = pending[0].detail;
    expect(d.from).toBe('in_transit');
    expect(d.to).toBe('draft');
    expect(d.fields.find(f => f.field === 'other_fees')).toMatchObject({ from: 0, to: 250 });
    expect(d.lines.edited).toHaveLength(1);
    expect(d.lines.edited[0].lineId).toBe(lineId);
    expect(d.lines.edited[0].changes.find(c => c.field === 'qty')).toMatchObject({ from: 4, to: 8 });
    expect(d.lines.added.map(l => l.lineId)).toEqual([addedId]);
    expect(d.lines.added[0]).toMatchObject({ qty: 2, unitCost: 40 });
    // The line the purchaser added lands in Draft alongside the rest.
    const after = await api<{ order: { lines: { id: string; status: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(after.body.order.lines.every(l => l.status === 'Draft')).toBe(true);
  });

  it('records a removed line', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);

    // A PO may not be emptied, so add a keeper before removing the original.
    const added = await api<{ addedLineIds: string[] }>('PATCH', `/api/orders/${id}`, {
      token: pur,
      body: { addLines: [{ category: 'RAM', partNumber: 'KEEP-1', condition: 'New', qty: 1, unitCost: 5 }] },
    });
    expect(added.status).toBe(200);
    // Back to In Transit so the removal is what reverts it.
    expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
    await api('POST', `/api/orders/${id}/revert-ack`, { token: mgr });

    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { removeLineIds: [lineId] },
    })).status).toBe(200);

    const pending = (await get(id, mgr)).body.order.pendingRevert!;
    expect(pending).toHaveLength(1);
    expect(pending[0].detail.lines.removed.map(l => l.lineId)).toEqual([lineId]);
  });
});

describe('pendingRevert + revert-ack handshake', () => {
  beforeEach(async () => { await resetDb(); });

  it('is empty before any revert and hidden from the purchaser', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);

    expect((await get(id, mgr)).body.order.pendingRevert).toEqual([]);

    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ id: lineId, unitCost: 1 }] },
    })).status).toBe(200);

    expect((await get(id, mgr)).body.order.pendingRevert).toHaveLength(1);
    // The purchaser who made the change is never shown the review dialog.
    expect((await get(id, pur)).body.order.pendingRevert ?? null).toBeNull();
  });

  it('clears for every manager once one acknowledges', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);
    await api('PATCH', `/api/orders/${id}`, { token: pur, body: { lines: [{ id: lineId, unitCost: 1 }] } });

    const ack = await api<{ acknowledged: number }>('POST', `/api/orders/${id}/revert-ack`, { token: mgr });
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledged).toBe(1);

    const { token: mgr2 } = await loginAs('sofia@recycleservers.io');
    expect((await get(id, mgr2)).body.order.pendingRevert).toEqual([]);
  });

  it('re-arms with only the new change after the order is resubmitted and edited again', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);

    await api('PATCH', `/api/orders/${id}`, { token: pur, body: { otherFees: 100 } });
    await api('POST', `/api/orders/${id}/revert-ack`, { token: mgr });
    expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);

    await api('PATCH', `/api/orders/${id}`, { token: pur, body: { lines: [{ id: lineId, qty: 9 }] } });

    const pending = (await get(id, mgr)).body.order.pendingRevert!;
    expect(pending).toHaveLength(1);
    expect(pending[0].detail.lines.edited[0].changes.find(c => c.field === 'qty'))
      .toMatchObject({ from: 4, to: 9 });
  });

  it('stacks consecutive unacknowledged reverts, newest first', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id } = await createSubmitted(pur);

    await api('PATCH', `/api/orders/${id}`, { token: pur, body: { otherFees: 10 } });
    await api('POST', `/api/orders/${id}/advance`, { token: pur });
    await api('PATCH', `/api/orders/${id}`, { token: pur, body: { otherFees: 20 } });

    const pending = (await get(id, mgr)).body.order.pendingRevert!;
    expect(pending).toHaveLength(2);
    expect(pending[0].detail.fields.find(f => f.field === 'other_fees')).toMatchObject({ from: 10, to: 20 });
    expect(pending[1].detail.fields.find(f => f.field === 'other_fees')).toMatchObject({ from: 0, to: 10 });

    const ack = await api<{ acknowledged: number }>('POST', `/api/orders/${id}/revert-ack`, { token: mgr });
    expect(ack.body.acknowledged).toBe(2);
    expect((await get(id, mgr)).body.order.pendingRevert).toEqual([]);
  });

  it('refuses the ack from a purchaser and writes nothing when nothing is pending', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);
    await api('PATCH', `/api/orders/${id}`, { token: pur, body: { lines: [{ id: lineId, unitCost: 2 }] } });

    expect((await api('POST', `/api/orders/${id}/revert-ack`, { token: pur })).status).toBe(403);
    expect((await get(id, mgr)).body.order.pendingRevert).toHaveLength(1);

    await api('POST', `/api/orders/${id}/revert-ack`, { token: mgr });
    const again = await api<{ acknowledged: number }>('POST', `/api/orders/${id}/revert-ack`, { token: mgr });
    expect(again.status).toBe(200);
    expect(again.body.acknowledged).toBe(0);

    const events = await api<{ events: { kind: string }[] }>(
      'GET', `/api/orders/${id}/events`, { token: mgr });
    expect(events.body.events.filter(e => e.kind === 'revert_ack')).toHaveLength(1);
  });
});

describe('revert guards', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses the edit when a line is committed to an open sell order', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);
    // in_transit → reviewing makes the line sellable.
    expect((await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'reviewing' },
    })).status).toBe(200);

    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token: mgr });
    const so = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId: customers.body.items[0].id,
        lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: 90 }],
      },
    });
    expect(so.status).toBe(201);

    const blocked = await api<{ error: string; offendingLineIds: string[] }>(
      'PATCH', `/api/orders/${id}`, { token: pur, body: { lines: [{ id: lineId, qty: 6 }] } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.offendingLineIds).toContain(lineId);

    // Nothing moved: the order is still Reviewing with its original qty.
    const after = await api<{ order: { lifecycle: string; lines: { qty: number }[] } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(after.body.order.lifecycle).toBe('reviewing');
    expect(after.body.order.lines[0].qty).toBe(4);
  });

  it('does not let a reverted order be deleted — it has already been submitted', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { id, lineId } = await createSubmitted(pur);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ id: lineId, unitCost: 3 }] },
    })).status).toBe(200);

    const del = await api<{ error: string }>('DELETE', `/api/orders/${id}`, { token: pur });
    expect(del.status).toBe(403);
    expect(del.body.error).toMatch(/already been submitted/i);
    expect((await api('GET', `/api/orders/${id}`, { token: pur })).status).toBe(200);
  });
});
