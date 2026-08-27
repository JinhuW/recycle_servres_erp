// The manager-facing half of the purchaser-edit revert: what the `reverted`
// event records, and the pending/acknowledged handshake that drives the
// "what changed" dialog.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
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

  it('archives a reverted order, since delete refuses it', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { id, lineId } = await createSubmitted(pur);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ id: lineId, unitCost: 3 }] },
    })).status).toBe(200);
    // Draft again — but a Draft that was submitted, so Archive has to take it
    // or the order can be neither deleted nor archived.
    expect((await api('GET', `/api/orders/${id}`, { token: pur })).status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/archive`, { token: pur })).status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/unarchive`, { token: pur })).status).toBe(200);
  });

  it('still refuses to archive a draft that was never submitted', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pur,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    const r = await api<{ error: string }>('POST', `/api/orders/${created.body.id}/archive`, { token: pur });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/delete instead/i);
  });

  it('refuses the edit when a line is out on an open transfer order', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);
    expect((await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'reviewing' },
    })).status).toBe(200);

    const moved = await api<{ transferOrderId: string }>('POST', '/api/inventory/transfer', {
      token: mgr, body: { toWarehouseId: 'WH-DAL', lines: [{ id: lineId, qty: 4 }] },
    });
    expect(moved.status).toBe(200);

    const blocked = await api<{ error: string; offendingLineIds: string[] }>(
      'PATCH', `/api/orders/${id}`, { token: pur, body: { lines: [{ id: lineId, qty: 6 }] } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/transfer order/i);
    expect(blocked.body.offendingLineIds).toContain(lineId);

    // The transfer order can still be received: its line never left In Transit.
    const recv = await api('POST', `/api/inventory/transfer-orders/${moved.body.transferOrderId}/receive`, { token: mgr });
    expect(recv.status).toBe(200);
  });

  it('refuses a backward advance that would strand a committed Reviewing line', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);
    expect((await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'reviewing' },
    })).status).toBe(200);

    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token: mgr });
    expect((await api('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId: customers.body.items[0].id,
        lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: 90 }],
      },
    })).status).toBe(201);

    // A sell order may claim a Reviewing line, so the backward guard has to
    // look at Reviewing as well as Done or it strands exactly that sell order.
    const back = await api<{ offendingLineIds: string[] }>('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'in_transit' },
    });
    expect(back.status).toBe(409);
    expect(back.body.offendingLineIds).toContain(lineId);
  });

  it('treats a manager stage-jump out of Draft as a submission', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pur,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    const id = created.body.id;
    // Jump straight to Reviewing and back. No `submitted` event is written on
    // either leg unless leaving Draft counts, and without it the order — whose
    // lines were sellable in between — is still hard-deletable.
    for (const toStage of ['reviewing', 'draft']) {
      expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage } })).status).toBe(200);
    }
    const del = await api<{ error: string }>('DELETE', `/api/orders/${id}`, { token: mgr });
    expect(del.status).toBe(403);
    expect(del.body.error).toMatch(/already been submitted/i);
  });
});

describe('no-op edits leave the stage alone', () => {
  beforeEach(async () => { await resetDb(); });

  it('does not revert when a re-saved line carries the values it already had', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);

    // What the mobile line editor sends when someone opens a line and saves it
    // untouched, and what a queued autosave replays.
    const r = await api<{ lifecycle: string }>('PATCH', `/api/orders/${id}`, {
      token: pur,
      body: { lines: [{ id: lineId, qty: 4, unitCost: 78.5 }], otherFees: 0 },
    });
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('in_transit');

    const after = await get(id, mgr);
    expect(after.body.order.lifecycle).toBe('in_transit');
    // No `reverted` row, so no manager is handed an empty change set to review.
    expect(after.body.order.pendingRevert ?? []).toHaveLength(0);
  });

  it('still reverts when one field of the same request really changes', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);

    const r = await api<{ lifecycle: string }>('PATCH', `/api/orders/${id}`, {
      token: pur,
      body: { lines: [{ id: lineId, qty: 4, unitCost: 79 }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('draft');
    expect((await get(id, mgr)).body.order.pendingRevert).toHaveLength(1);
  });

  it('reads a fee that differs only in float noise as unchanged', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { id } = await createSubmitted(pur);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { otherFees: 250.3 },
    })).status).toBe(200);
    // The order is Draft now; re-submit, then send the value back the way a
    // rounded input would.
    expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
    const again = await api<{ lifecycle: string }>('PATCH', `/api/orders/${id}`, {
      token: pur, body: { otherFees: 12.1 + 238.2 },
    });
    expect(again.status).toBe(200);
    expect(again.body.lifecycle).toBe('in_transit');
  });
});

describe('revert acknowledgement is by event id, not timestamp', () => {
  beforeEach(async () => { await resetDb(); });

  it('keeps a revert pending when its event is stamped before an existing ack', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await createSubmitted(pur);

    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ id: lineId, unitCost: 80 }] },
    })).status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/revert-ack`, { token: mgr })).status).toBe(200);
    expect((await get(id, mgr)).body.order.pendingRevert).toHaveLength(0);

    // A concurrent PATCH stamps its `reverted` row at transaction-START time
    // and commits after the ack. Under a timestamp watermark that change set is
    // swallowed forever and no later ack can bring it back.
    const db = getTestDb();
    await db`
      INSERT INTO order_events (order_id, actor_id, kind, detail, created_at)
      VALUES (${id}, NULL, 'reverted',
              ${db.json({ from: 'in_transit', to: 'draft', fields: [], lines: { added: [], removed: [], edited: [] } })},
              NOW() - INTERVAL '1 hour')`;

    const pending = (await get(id, mgr)).body.order.pendingRevert!;
    expect(pending).toHaveLength(1);
    // And it can be acknowledged normally once it is seen.
    expect((await api('POST', `/api/orders/${id}/revert-ack`, { token: mgr })).status).toBe(200);
    expect((await get(id, mgr)).body.order.pendingRevert).toHaveLength(0);
  });
});
