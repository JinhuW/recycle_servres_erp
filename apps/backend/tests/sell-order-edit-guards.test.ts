// What keeps a sell order's lines honest against writers it doesn't see: the
// editor's save against Pack mode's qty write-back, ticks against lines that
// left the order, a reopen against the old ticks, and the boundary checks on
// what a save may name.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { firstCustomerId } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';
import { eventsOf } from './helpers/sellOrderEvents';

type Line = {
  id: string; inventoryId: string | null; category: string; label: string; sub: string | null;
  partNumber: string | null; qty: number; nativeUnitPrice: number; warehouseId: string | null;
  condition: string | null;
};
type Detail = { linesVersion: string; lines: Line[]; signoff: { fingerprint: string } };
type Pack = { lines: { lineId: string; qty: number; counted: number; packedAt: string | null }[] };

const TYPED = { category: 'Other', label: 'Rail kit', partNumber: 'RAIL-1', qty: 3, unitPrice: 12 };

let mgr: string;

async function detail(id: string): Promise<Detail> {
  const r = await api<{ order: Detail }>('GET', `/api/sell-orders/${id}`, { token: mgr });
  expect(r.status).toBe(200);
  return r.body.order;
}

async function createOrder(): Promise<{ id: string; lot: string; lotQty: number }> {
  const lot = await freeSellableLine(mgr, 2);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: mgr,
    body: {
      customerId: await firstCustomerId(mgr),
      lines: [
        { inventoryId: lot.id, category: 'RAM', label: 'x', partNumber: 'GUARD-PN', qty: 2, unitPrice: 90 },
        TYPED,
      ],
    },
  });
  expect(r.status).toBe(201);
  return { id: r.body.id, lot: lot.id, lotQty: lot.qty };
}

const resend = (lines: Line[]) => lines.map(l => ({
  id: l.id, inventoryId: l.inventoryId, category: l.category, label: l.label, subLabel: l.sub,
  partNumber: l.partNumber, qty: l.qty, unitPrice: l.nativeUnitPrice,
  warehouseId: l.warehouseId, condition: l.condition,
}));

const patch = (id: string, body: unknown) =>
  api<{ ok?: boolean; linesVersion?: string | null; error?: string; code?: string }>(
    'PATCH', `/api/sell-orders/${id}`, { token: mgr, body });
const putPack = (id: string, lineId: string, body: unknown) =>
  api<Pack & { error?: string }>('PUT', `/api/sell-orders/${id}/pack/${lineId}`, { token: mgr, body });
const packRows = async (id: string) =>
  (await getTestDb()`SELECT line_key FROM sell_order_packs WHERE sell_order_id = ${id}`).length;

describe('sell order edit guards', () => {
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  it('accepts a save carrying the version its own price adjust returned', async () => {
    const { id } = await createOrder();
    const loaded = await detail(id);
    const saved = await patch(id, { lines: resend(loaded.lines), linesVersion: loaded.linesVersion });
    expect(saved.status).toBe(200);
    const adj = await api<{ linesVersion?: string }>('POST', `/api/sell-orders/${id}/adjust-price`, {
      token: mgr, body: { targetTotal: 200 },
    });
    expect(adj.status).toBe(200);
    expect(adj.body.linesVersion).toBe((await detail(id)).linesVersion);
    // The editor retries with its own lines after a later step failed.
    const retry = await patch(id, { lines: resend((await detail(id)).lines), linesVersion: adj.body.linesVersion });
    expect(retry.status).toBe(200);
  });

  it("refuses an editor save loaded before Pack mode wrote a short count back", async () => {
    const { id, lot } = await createOrder();
    const loaded = await detail(id);
    const lotLine = loaded.lines.find(l => l.inventoryId === lot)!;

    // The packer finds 1 of 2: a Draft takes its qty from the box.
    expect((await putPack(id, lotLine.id, { counted: 1, packed: true })).status).toBe(200);
    expect((await detail(id)).lines.find(l => l.inventoryId === lot)!.qty).toBe(1);

    // The manager's open editor saves a price edit with the qty it loaded.
    const stale = resend(loaded.lines).map(l => (l.inventoryId === null ? { ...l, unitPrice: 15 } : l));
    const r = await patch(id, { lines: stale, linesVersion: loaded.linesVersion });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('lines_changed');
    expect((await detail(id)).lines.find(l => l.inventoryId === lot)!.qty).toBe(1);

    // Reloaded, the same edit goes through, and its answer is the next base.
    const fresh = await detail(id);
    const ok = await patch(id, {
      lines: resend(fresh.lines).map(l => (l.inventoryId === null ? { ...l, unitPrice: 15 } : l)),
      linesVersion: fresh.linesVersion,
    });
    expect(ok.status).toBe(200);
    const after = await detail(id);
    expect(ok.body.linesVersion).toBe(after.linesVersion);
    expect(after.lines.find(l => l.inventoryId === lot)!.qty).toBe(1);
    expect((await patch(id, { lines: resend(after.lines), linesVersion: ok.body.linesVersion })).status).toBe(200);
  });

  it('a notes-only save is not held to the line version', async () => {
    const { id, lot } = await createOrder();
    const loaded = await detail(id);
    await putPack(id, loaded.lines.find(l => l.inventoryId === lot)!.id, { counted: 1, packed: true });
    expect((await patch(id, { notes: 'call first', linesVersion: loaded.linesVersion })).status).toBe(200);
  });

  it('drops the tick of a line removed from the order, so the lot added back reads unpacked', async () => {
    const { id, lot } = await createOrder();
    const start = await detail(id);
    const lotLine = start.lines.find(l => l.inventoryId === lot)!;
    expect((await putPack(id, lotLine.id, { counted: 2, packed: true })).status).toBe(200);

    const without = resend(start.lines).filter(l => l.inventoryId !== lot);
    expect((await patch(id, { lines: without })).status).toBe(200);
    expect(await packRows(id)).toBe(0);

    const back = await detail(id);
    expect((await patch(id, {
      lines: [...resend(back.lines), { ...resend([lotLine])[0], id: null }],
    })).status).toBe(200);
    const readded = (await detail(id)).lines.find(l => l.inventoryId === lot)!;
    const pack = await api<Pack>('GET', `/api/sell-orders/${id}/pack`, { token: mgr });
    expect(pack.body.lines.find(l => l.lineId === readded.id)).toMatchObject({ packedAt: null });
  });

  it('a Closed order reopened to Draft starts unpacked', async () => {
    const { id, lot } = await createOrder();
    const lines = (await detail(id)).lines;
    await putPack(id, lines.find(l => l.inventoryId === lot)!.id, { counted: 2, packed: true });
    await putPack(id, lines.find(l => l.inventoryId === null)!.id, { counted: 3, packed: true });
    expect(await packRows(id)).toBe(2);

    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: mgr, body: { to: 'Closed', closeReasonId: 'customer_cancelled', note: 'gone' },
    })).status).toBe(200);
    expect(await packRows(id)).toBe(2);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: mgr, body: { to: 'Draft', note: 'back on' },
    })).status).toBe(200);
    expect(await packRows(id)).toBe(0);
  });

  it('refuses a qty past the cap on create and on save', async () => {
    const customerId = await firstCustomerId(mgr);
    for (const qty of [100_001, 2 ** 31]) {
      const created = await api<{ error: string }>('POST', '/api/sell-orders', {
        token: mgr, body: { customerId, lines: [{ ...TYPED, qty }] },
      });
      expect(created.status).toBe(400);
    }
    const { id } = await createOrder();
    const lines = resend((await detail(id)).lines).map(l => (l.inventoryId === null ? { ...l, qty: 2 ** 31 } : l));
    expect((await patch(id, { lines })).status).toBe(400);
    expect((await api('GET', '/api/sell-orders', { token: mgr })).status).toBe(200);
  });

  it('counts two spellings of one lot as one demand', async () => {
    const lot = await freeSellableLine(mgr, 1);
    const r = await api<{ error: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId: await firstCustomerId(mgr),
        lines: [
          { inventoryId: lot.id.toLowerCase(), category: 'RAM', label: 'x', qty: lot.qty, unitPrice: 1 },
          { inventoryId: lot.id.toUpperCase(), category: 'RAM', label: 'x', qty: lot.qty, unitPrice: 1 },
        ],
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceeds/);
  });

  it('a save naming a lot held at 0 that is deleted mid-save answers 400, not a 500', async () => {
    const { id, lot } = await createOrder();
    const start = await detail(id);
    expect((await patch(id, {
      lines: resend(start.lines).map(l => (l.inventoryId === lot ? { ...l, qty: 0 } : l)),
    })).status).toBe(200);
    const held = await detail(id);

    // A PO edit deletes the lot and holds its transaction open across the save.
    const sql = getTestDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let deleted!: () => void;
    const didDelete = new Promise<void>((r) => { deleted = r; });
    const holder = sql.begin(async (tx) => {
      await tx`DELETE FROM order_lines WHERE id = ${lot}`;
      deleted();
      await gate;
    });
    await didDelete;
    const save = patch(id, {
      lines: resend(held.lines).map(l => (l.inventoryId === null ? { ...l, unitPrice: 20 } : l)),
    });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const r = await save;
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not found/);
  });

  it('signing twice before the page re-reads records one sign-off', async () => {
    const { id } = await createOrder();
    const fp = (await detail(id)).signoff.fingerprint;
    for (let i = 0; i < 2; i++) {
      expect((await api('POST', `/api/sell-orders/${id}/signoff`, { token: mgr, body: { fingerprint: fp } })).status).toBe(200);
    }
    expect((await eventsOf(id)).filter(e => e.kind === 'signed_off')).toHaveLength(1);
  });
});
