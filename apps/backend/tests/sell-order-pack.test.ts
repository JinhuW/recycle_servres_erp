// Pack mode: a manager ticking a sell order's lines into the box. Progress is
// keyed on the line's identity (its lot, or a hand-typed line's text), not its
// row id, because a line edit deletes and re-inserts every row.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { firstCustomerId } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';

type Pack = {
  lines: { lineId: string; counted: number; packedAt: string | null; serialNumber: string | null }[];
};
type DetailLine = {
  id: string; inventoryId: string | null; category: string; label: string; sub: string | null;
  partNumber: string | null; qty: number; nativeUnitPrice: number; warehouseId: string | null;
  condition: string | null;
};

const TYPED = { category: 'Other', label: 'Rail kit', partNumber: 'RAIL-1', qty: 3, unitPrice: 12 };

async function createOrder(mgr: string): Promise<{ id: string; picked: string; lot: string }> {
  const lot = await freeSellableLine(mgr, 2);
  const so = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: mgr,
    body: {
      customerId: await firstCustomerId(mgr),
      lines: [
        { inventoryId: lot.id, category: 'RAM', label: 'x', partNumber: 'PACK-PN', qty: 2, unitPrice: 90 },
        TYPED,
      ],
    },
  });
  expect(so.status).toBe(201);
  const lines = await detailLines(mgr, so.body.id);
  return { id: so.body.id, picked: lines.find(l => l.inventoryId === lot.id)!.id, lot: lot.id };
}

async function detailLines(mgr: string, id: string): Promise<DetailLine[]> {
  const r = await api<{ order: { lines: DetailLine[] } }>('GET', `/api/sell-orders/${id}`, { token: mgr });
  expect(r.status).toBe(200);
  return r.body.order.lines;
}

// The editor's save: every line sent back, which rewrites every row.
async function rewriteLines(mgr: string, id: string, edit: (l: DetailLine) => Partial<{ qty: number; unitPrice: number }>) {
  const lines = await detailLines(mgr, id);
  const r = await api('PATCH', `/api/sell-orders/${id}`, {
    token: mgr,
    body: {
      lines: lines.map(l => ({
        inventoryId: l.inventoryId, category: l.category, label: l.label, subLabel: l.sub,
        partNumber: l.partNumber, qty: l.qty, unitPrice: l.nativeUnitPrice,
        warehouseId: l.warehouseId, condition: l.condition, ...edit(l),
      })),
    },
  });
  expect(r.status).toBe(200);
  return detailLines(mgr, id);
}

const getPack = (mgr: string, id: string) => api<Pack>('GET', `/api/sell-orders/${id}/pack`, { token: mgr });
const putPack = (mgr: string, id: string, lineId: string, body: unknown) =>
  api<Pack>('PUT', `/api/sell-orders/${id}/pack/${lineId}`, { token: mgr, body });
const rowOf = (p: Pack, lineId: string) => p.lines.find(l => l.lineId === lineId)!;

describe('sell order pack mode', () => {
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  it('reads every line full and unpacked until it is touched', async () => {
    const { id } = await createOrder(mgr);
    const r = await getPack(mgr, id);
    expect(r.status).toBe(200);
    const lines = await detailLines(mgr, id);
    expect(r.body.lines).toHaveLength(2);
    for (const l of lines) {
      expect(rowOf(r.body, l.id)).toMatchObject({ counted: l.qty, packedAt: null });
    }
  });

  it('ticks, keeps the first tick time on a re-tick, and unticks', async () => {
    const { id, picked } = await createOrder(mgr);
    const first = await putPack(mgr, id, picked, { counted: 2, packed: true });
    expect(first.status).toBe(200);
    const at = rowOf(first.body, picked).packedAt;
    expect(at).not.toBeNull();

    const again = await putPack(mgr, id, picked, { counted: 2, packed: true });
    expect(rowOf(again.body, picked).packedAt).toBe(at);

    const short = await putPack(mgr, id, picked, { counted: 1, packed: false });
    expect(rowOf(short.body, picked)).toMatchObject({ counted: 1, packedAt: null });
    expect(rowOf((await getPack(mgr, id)).body, picked)).toMatchObject({ counted: 1, packedAt: null });
  });

  it('rejects a bad body', async () => {
    const { id, picked } = await createOrder(mgr);
    for (const body of [
      { counted: 3, packed: true }, { counted: -1, packed: true }, { counted: 1.5, packed: true },
      { counted: 1 }, { counted: 1, packed: 'yes' }, null,
    ]) {
      expect((await putPack(mgr, id, picked, body)).status).toBe(400);
    }
  });

  it('404s a line that is not on the order', async () => {
    const { id, picked } = await createOrder(mgr);
    const other = await createOrder(mgr);
    expect((await putPack(mgr, id, other.picked, { counted: 1, packed: true })).status).toBe(404);
    expect((await putPack(mgr, id, '00000000-0000-0000-0000-000000000000', { counted: 1, packed: true })).status).toBe(404);
    expect((await putPack(mgr, id, 'not-a-uuid', { counted: 1, packed: true })).status).toBe(404);
    expect((await putPack(mgr, 'SO-NOPE', picked, { counted: 1, packed: true })).status).toBe(404);
    expect((await getPack(mgr, 'SO-NOPE')).status).toBe(404);
  });

  it('is manager-only', async () => {
    const { id, picked } = await createOrder(mgr);
    const pur = (await loginAs(MARCUS)).token;
    expect((await getPack(pur, id)).status).toBe(403);
    expect((await putPack(pur, id, picked, { counted: 1, packed: true })).status).toBe(403);
  });

  it('keeps the ticks when an edit rewrites the lines', async () => {
    const { id, picked, lot } = await createOrder(mgr);
    const typedId = (await detailLines(mgr, id)).find(l => l.inventoryId === null)!.id;
    await putPack(mgr, id, picked, { counted: 2, packed: true });
    await putPack(mgr, id, typedId, { counted: 3, packed: true });

    const after = await rewriteLines(mgr, id, () => ({ unitPrice: 95 }));
    const newPicked = after.find(l => l.inventoryId === lot)!.id;
    const newTyped = after.find(l => l.inventoryId === null)!.id;
    expect(newPicked).not.toBe(picked);
    const p = (await getPack(mgr, id)).body;
    expect(rowOf(p, newPicked).packedAt).not.toBeNull();
    expect(rowOf(p, newTyped).packedAt).not.toBeNull();
  });

  it('a qty change unpacks that line only', async () => {
    const { id, picked, lot } = await createOrder(mgr);
    const typedId = (await detailLines(mgr, id)).find(l => l.inventoryId === null)!.id;
    await putPack(mgr, id, picked, { counted: 2, packed: true });
    await putPack(mgr, id, typedId, { counted: 3, packed: true });

    const after = await rewriteLines(mgr, id, l => (l.inventoryId === null ? { qty: 5 } : {}));
    const p = (await getPack(mgr, id)).body;
    expect(rowOf(p, after.find(l => l.inventoryId === lot)!.id).packedAt).not.toBeNull();
    expect(rowOf(p, after.find(l => l.inventoryId === null)!.id)).toMatchObject({ counted: 5, packedAt: null });
  });

  it('a line packed short and edited down to its count stays packed', async () => {
    const { id, picked, lot } = await createOrder(mgr);
    await putPack(mgr, id, picked, { counted: 1, packed: true });

    const after = await rewriteLines(mgr, id, l => (l.inventoryId === lot ? { qty: 1 } : {}));
    const newPicked = after.find(l => l.inventoryId === lot)!.id;
    const row = rowOf((await getPack(mgr, id)).body, newPicked);
    expect(row.counted).toBe(1);
    expect(row.packedAt).not.toBeNull();

    // A write at the new qty restamps the row against it.
    const re = await putPack(mgr, id, newPicked, { counted: 1, packed: true });
    expect(rowOf(re.body, newPicked).packedAt).not.toBeNull();
  });

  it('refuses writes on a Closed or archived order but still reads it', async () => {
    const { id, picked } = await createOrder(mgr);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: mgr, body: { to: 'Closed', closeReasonId: 'customer_cancelled' },
    })).status).toBe(200);
    expect((await putPack(mgr, id, picked, { counted: 1, packed: true })).status).toBe(409);

    expect((await api('POST', `/api/sell-orders/${id}/archive`, { token: mgr })).status).toBe(200);
    expect((await putPack(mgr, id, picked, { counted: 1, packed: true })).status).toBe(409);
    expect((await getPack(mgr, id)).status).toBe(200);
  });
});
