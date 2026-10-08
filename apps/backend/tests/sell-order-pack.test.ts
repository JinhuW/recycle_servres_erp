// Pack mode: a manager ticking a sell order's lines into the box. Progress is
// keyed on the line's identity (its lot, or a hand-typed line's text), not its
// row id, because a line edit deletes and re-inserts every row.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { firstCustomerId } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';
import { eventsOf } from './helpers/sellOrderEvents';

type Pack = {
  lines: { lineId: string; qty: number; counted: number; packedAt: string | null; serialNumber: string | null }[];
};
type DetailLine = {
  id: string; no: number; inventoryId: string | null; category: string; label: string; sub: string | null;
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

  it('keeps each tick on its own line when two same-text typed lines in two warehouses swap places', async () => {
    const so = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId: await firstCustomerId(mgr),
        lines: [{ ...TYPED, warehouseId: 'WH-NJ2' }, { ...TYPED, warehouseId: 'WH-LA1' }],
      },
    });
    expect(so.status).toBe(201);
    const nj = (await detailLines(mgr, so.body.id)).find(l => l.warehouseId === 'WH-NJ2')!.id;
    await putPack(mgr, so.body.id, nj, { counted: 3, packed: true });

    // The page lists LA1 first, so saving it as shown swaps their positions.
    const after = await rewriteLines(mgr, so.body.id, () => ({}));
    const p = (await getPack(mgr, so.body.id)).body;
    expect(rowOf(p, after.find(l => l.warehouseId === 'WH-NJ2')!.id).packedAt).not.toBeNull();
    expect(rowOf(p, after.find(l => l.warehouseId === 'WH-LA1')!.id).packedAt).toBeNull();
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

    // A re-tick at the count leaves it packed.
    const re = await putPack(mgr, id, newPicked, { counted: 1, packed: true });
    expect(rowOf(re.body, newPicked).packedAt).not.toBeNull();
  });

  it('refuses to pack a line held at 0 — there is nothing of it to pack', async () => {
    const { id, lot } = await createOrder(mgr);
    const after = await rewriteLines(mgr, id, l => (l.inventoryId === lot ? { qty: 0 } : {}));
    const zero = after.find(l => l.inventoryId === lot)!.id;
    expect(rowOf((await getPack(mgr, id)).body, zero)).toMatchObject({ counted: 0, packedAt: null });
    expect((await putPack(mgr, id, zero, { counted: 0, packed: true })).status).toBe(409);
  });

  // On a Draft, the tick writes what went in the box onto the order.
  describe('a tick on a Draft sets the line to the count', () => {
    it('does the same on a Packing order, and an untick puts the qty back', async () => {
      const { id, picked } = await createOrder(mgr);
      expect((await api('POST', `/api/sell-orders/${id}/status`, {
        token: mgr, body: { to: 'Packing' },
      })).status).toBe(200);
      expect(rowOf((await putPack(mgr, id, picked, { counted: 1, packed: true })).body, picked))
        .toMatchObject({ qty: 1, counted: 1 });
      expect((await detailLines(mgr, id)).find(l => l.id === picked)!.qty).toBe(1);
      expect((await putPack(mgr, id, picked, { counted: 1, packed: false })).status).toBe(200);
      expect((await detailLines(mgr, id)).find(l => l.id === picked)!.qty).toBe(2);
    });

    it('lowers the qty in place, reads packed, and records the edit', async () => {
      const { id, picked, lot } = await createOrder(mgr);
      const r = await putPack(mgr, id, picked, { counted: 1, packed: true });
      expect(r.status).toBe(200);
      expect(rowOf(r.body, picked)).toMatchObject({ qty: 1, counted: 1 });
      expect(rowOf(r.body, picked).packedAt).not.toBeNull();

      const line = (await detailLines(mgr, id)).find(l => l.id === picked)!;
      expect(line.qty).toBe(1);
      const edits = (await eventsOf(id)).filter(e => e.kind === 'line_edited');
      expect(edits).toHaveLength(1);
      expect(edits[0]!.detail).toMatchObject({ inventoryId: lot, changes: [{ field: 'qty', from: 2, to: 1 }] });
    });

    it('puts the qty back on an untick, keeping the count', async () => {
      const { id, picked } = await createOrder(mgr);
      await putPack(mgr, id, picked, { counted: 1, packed: true });
      const r = await putPack(mgr, id, picked, { counted: 1, packed: false });
      expect(r.status).toBe(200);
      expect(rowOf(r.body, picked)).toMatchObject({ qty: 2, counted: 1, packedAt: null });
      expect((await detailLines(mgr, id)).find(l => l.id === picked)!.qty).toBe(2);
      const edits = (await eventsOf(id)).filter(e => e.kind === 'line_edited');
      expect(edits.map(e => (e.detail as { changes: unknown[] }).changes)).toEqual([
        [{ field: 'qty', from: 2, to: 1 }], [{ field: 'qty', from: 1, to: 2 }],
      ]);
    });

    it('a re-tick of a lowered line keeps what an untick puts back', async () => {
      const { id, picked } = await createOrder(mgr);
      const first = await putPack(mgr, id, picked, { counted: 1, packed: true });
      const again = await putPack(mgr, id, picked, { counted: 1, packed: true });
      expect(rowOf(again.body, picked).packedAt).toBe(rowOf(first.body, picked).packedAt);
      await putPack(mgr, id, picked, { counted: 1, packed: false });
      expect((await detailLines(mgr, id)).find(l => l.id === picked)!.qty).toBe(2);
    });

    it('a typed line goes to the count too, named in its edit', async () => {
      const { id } = await createOrder(mgr);
      const typedId = (await detailLines(mgr, id)).find(l => l.inventoryId === null)!.id;
      await putPack(mgr, id, typedId, { counted: 2, packed: true });
      expect((await detailLines(mgr, id)).find(l => l.id === typedId)!.qty).toBe(2);
      const edit = (await eventsOf(id)).find(e => e.kind === 'line_edited')!;
      expect(edit.detail).toMatchObject({ inventoryId: null, partNumber: 'RAIL-1' });
    });

    it('a 0 holds the line at 0 with its #, and an untick brings it back', async () => {
      const { id, picked } = await createOrder(mgr);
      const before = await detailLines(mgr, id);
      const r = await putPack(mgr, id, picked, { counted: 0, packed: true });
      expect(r.status).toBe(200);
      expect(rowOf(r.body, picked)).toMatchObject({ qty: 0, counted: 0, packedAt: null });
      const after = await detailLines(mgr, id);
      expect(after.find(l => l.id === picked)!.qty).toBe(0);
      expect(after.map(l => [l.id, l.no])).toEqual(before.map(l => [l.id, l.no]));

      // Nothing to pack at 0, but the tick that put it there can be taken back.
      expect((await putPack(mgr, id, picked, { counted: 0, packed: true })).status).toBe(409);
      const back = await putPack(mgr, id, picked, { counted: 0, packed: false });
      expect(back.status).toBe(200);
      expect(rowOf(back.body, picked)).toMatchObject({ qty: 2, counted: 0, packedAt: null });
    });

    it('leaves a qty edited since alone', async () => {
      const { id, picked, lot } = await createOrder(mgr);
      await putPack(mgr, id, picked, { counted: 1, packed: true });
      // The editor set it back to 2 — no longer the count the tick lowered it to.
      const after = await rewriteLines(mgr, id, l => (l.inventoryId === lot ? { qty: 2 } : {}));
      const newPicked = after.find(l => l.inventoryId === lot)!.id;
      await putPack(mgr, id, newPicked, { counted: 2, packed: false });
      expect((await detailLines(mgr, id)).find(l => l.id === newPicked)!.qty).toBe(2);
    });

    it('refuses to put the qty back once the lot is sold elsewhere', async () => {
      const { id, picked, lot } = await createOrder(mgr);
      await putPack(mgr, id, picked, { counted: 0, packed: true });
      const lotQty = (await api<{ items: { id: string; qty: number }[] }>(
        'GET', '/api/inventory?status=Reviewing', { token: mgr })).body.items.find(i => i.id === lot)!.qty;
      const rival = await api<{ id: string }>('POST', '/api/sell-orders', {
        token: mgr,
        body: {
          customerId: await firstCustomerId(mgr),
          lines: [{ inventoryId: lot, category: 'RAM', label: 'x', partNumber: 'PACK-PN', qty: lotQty, unitPrice: 90 }],
        },
      });
      expect(rival.status).toBe(201);
      expect((await api('POST', `/api/sell-orders/${rival.body.id}/status`, {
        token: mgr, body: { to: 'Shipped' },
      })).status).toBe(200);

      expect((await putPack(mgr, id, picked, { counted: 0, packed: false })).status).toBe(409);
      expect((await detailLines(mgr, id)).find(l => l.id === picked)!.qty).toBe(0);
    });

    it('never writes the qty once the order has left Draft', async () => {
      const { id, picked } = await createOrder(mgr);
      expect((await api('POST', `/api/sell-orders/${id}/status`, {
        token: mgr, body: { to: 'Shipped' },
      })).status).toBe(200);
      const r = await putPack(mgr, id, picked, { counted: 1, packed: true });
      expect(r.status).toBe(200);
      expect(rowOf(r.body, picked)).toMatchObject({ qty: 2, counted: 1 });
      expect((await detailLines(mgr, id)).find(l => l.id === picked)!.qty).toBe(2);
      expect((await eventsOf(id)).some(e => e.kind === 'line_edited')).toBe(false);
    });
  });

  // Apply: the lots lowered and left unticked, ticked at their counts at once.
  describe('apply on a Draft', () => {
    // Two same-text typed lines are one product, under one #.
    async function bigOrder() {
      const lot = await freeSellableLine(mgr, 2);
      const so = await api<{ id: string }>('POST', '/api/sell-orders', {
        token: mgr,
        body: {
          customerId: await firstCustomerId(mgr),
          lines: [
            { inventoryId: lot.id, category: 'RAM', label: 'x', partNumber: 'PACK-PN', qty: 2, unitPrice: 90 },
            TYPED,
            { ...TYPED, qty: 2 },
            { category: 'Other', label: 'Bezel', partNumber: 'BEZ-1', qty: 4, unitPrice: 5 },
            { category: 'Other', label: 'Cable', partNumber: 'CAB-1', qty: 1, unitPrice: 3 },
          ],
        },
      });
      expect(so.status).toBe(201);
      const lines = await detailLines(mgr, so.body.id);
      const rails = lines.filter(l => l.partNumber === 'RAIL-1');
      return {
        id: so.body.id,
        lines,
        picked: lines.find(l => l.inventoryId === lot.id)!.id,
        rail3: rails.find(l => l.qty === 3)!.id,
        rail2: rails.find(l => l.qty === 2)!.id,
        bezel: lines.find(l => l.partNumber === 'BEZ-1')!.id,
        cable: lines.find(l => l.partNumber === 'CAB-1')!.id,
      };
    }
    const apply = (token: string, id: string, body: unknown) =>
      api<Pack & { applied: string[] }>('POST', `/api/sell-orders/${id}/pack/apply`, { token, body });

    // Lowered and left: the lot and one rail lot at 0, the bezel short. The
    // other rail lot is ticked in full, the cable untouched.
    async function flag(o: Awaited<ReturnType<typeof bigOrder>>) {
      await putPack(mgr, o.id, o.picked, { counted: 0, packed: false });
      await putPack(mgr, o.id, o.rail3, { counted: 0, packed: false });
      await putPack(mgr, o.id, o.bezel, { counted: 2, packed: false });
      await putPack(mgr, o.id, o.rail2, { counted: 2, packed: true });
    }

    it('sets each lowered lot to its count in place, keeping every #, and records each edit', async () => {
      const o = await bigOrder();
      const noOf = new Map(o.lines.map(l => [l.id, l.no]));
      expect(noOf.get(o.rail3)).toBe(noOf.get(o.rail2));
      await flag(o);

      const r = await apply(mgr, o.id, { lineIds: o.lines.map(l => l.id) });
      expect(r.status).toBe(200);
      expect([...r.body.applied].sort()).toEqual([o.picked, o.rail3, o.bezel].sort());
      expect(rowOf(r.body, o.picked)).toMatchObject({ qty: 0, counted: 0, packedAt: null });
      expect(rowOf(r.body, o.rail3)).toMatchObject({ qty: 0, counted: 0, packedAt: null });
      expect(rowOf(r.body, o.bezel)).toMatchObject({ qty: 2, counted: 2 });
      expect(rowOf(r.body, o.bezel).packedAt).not.toBeNull();
      expect(rowOf(r.body, o.cable)).toMatchObject({ qty: 1, counted: 1, packedAt: null });

      const after = await detailLines(mgr, o.id);
      expect(new Map(after.map(l => [l.id, l.no]))).toEqual(noOf);
      expect(Object.fromEntries(after.map(l => [l.id, l.qty]))).toEqual({
        [o.picked]: 0, [o.rail3]: 0, [o.rail2]: 2, [o.bezel]: 2, [o.cable]: 1,
      });
      const edits = (await eventsOf(o.id)).filter(e => e.kind === 'line_edited');
      expect(edits.map(e => (e.detail as { partNumber: string; changes: unknown[] }))
        .map(d => [d.partNumber, d.changes]).sort()).toEqual([
        ['BEZ-1', [{ field: 'qty', from: 4, to: 2 }]],
        ['PACK-PN', [{ field: 'qty', from: 2, to: 0 }]],
        ['RAIL-1', [{ field: 'qty', from: 3, to: 0 }]],
      ]);
    });

    it('an untick of each, as Undo sends them, puts every qty back', async () => {
      const o = await bigOrder();
      await flag(o);
      await apply(mgr, o.id, { lineIds: o.lines.map(l => l.id) });
      const back = await Promise.all([
        putPack(mgr, o.id, o.picked, { counted: 0, packed: false }),
        putPack(mgr, o.id, o.rail3, { counted: 0, packed: false }),
        putPack(mgr, o.id, o.bezel, { counted: 2, packed: false }),
      ]);
      expect(back.map(r => r.status)).toEqual([200, 200, 200]);
      const p = (await getPack(mgr, o.id)).body;
      expect(rowOf(p, o.picked)).toMatchObject({ qty: 2, counted: 0, packedAt: null });
      expect(rowOf(p, o.rail3)).toMatchObject({ qty: 3, counted: 0, packedAt: null });
      expect(rowOf(p, o.bezel)).toMatchObject({ qty: 4, counted: 2, packedAt: null });
    });

    it('skips a lot no longer lowered, so a second apply changes nothing', async () => {
      const o = await bigOrder();
      await flag(o);
      await apply(mgr, o.id, { lineIds: [o.bezel] });
      const again = await apply(mgr, o.id, { lineIds: [o.bezel, o.rail2, o.cable] });
      expect(again.status).toBe(200);
      expect(again.body.applied).toEqual([]);
      expect((await eventsOf(o.id)).filter(e => e.kind === 'line_edited')).toHaveLength(1);
      // The lots it wasn't asked about stay lowered.
      expect(rowOf(again.body, o.picked)).toMatchObject({ qty: 2, counted: 0, packedAt: null });
    });

    it('applies on a Packing order too', async () => {
      const o = await bigOrder();
      expect((await api('POST', `/api/sell-orders/${o.id}/status`, {
        token: mgr, body: { to: 'Packing' },
      })).status).toBe(200);
      await flag(o);
      const r = await apply(mgr, o.id, { lineIds: [o.bezel] });
      expect(r.status).toBe(200);
      expect(r.body.applied).toEqual([o.bezel]);
      expect((await detailLines(mgr, o.id)).find(l => l.id === o.bezel)!.qty).toBe(2);
    });

    it('refuses an order past Packing and writes nothing', async () => {
      const o = await bigOrder();
      expect((await api('POST', `/api/sell-orders/${o.id}/status`, {
        token: mgr, body: { to: 'Shipped' },
      })).status).toBe(200);
      await putPack(mgr, o.id, o.bezel, { counted: 2, packed: false });
      expect((await apply(mgr, o.id, { lineIds: [o.bezel] })).status).toBe(409);
      expect((await detailLines(mgr, o.id)).find(l => l.id === o.bezel)!.qty).toBe(4);
      expect((await eventsOf(o.id)).some(e => e.kind === 'line_edited')).toBe(false);
    });

    it('is manager-only and rejects a bad body', async () => {
      const { id, picked } = await createOrder(mgr);
      const pur = (await loginAs(MARCUS)).token;
      expect((await apply(pur, id, { lineIds: [picked] })).status).toBe(403);
      for (const body of [null, {}, { lineIds: [] }, { lineIds: picked }, { lineIds: ['not-a-uuid'] }]) {
        expect((await apply(mgr, id, body)).status).toBe(400);
      }
      expect((await apply(mgr, 'SO-NOPE', { lineIds: [picked] })).status).toBe(404);
    });
  });

  it('refuses writes on a Closed or archived order but still reads it', async () => {
    const { id, picked } = await createOrder(mgr);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: mgr, body: { to: 'Closed', closeReasonId: 'customer_cancelled' },
    })).status).toBe(200);
    expect((await putPack(mgr, id, picked, { counted: 1, packed: true })).status).toBe(409);
    expect((await api('POST', `/api/sell-orders/${id}/pack/apply`, { token: mgr, body: { lineIds: [picked] } })).status).toBe(409);

    expect((await api('POST', `/api/sell-orders/${id}/archive`, { token: mgr })).status).toBe(200);
    expect((await putPack(mgr, id, picked, { counted: 1, packed: true })).status).toBe(409);
    expect((await api('POST', `/api/sell-orders/${id}/pack/apply`, { token: mgr, body: { lineIds: [picked] } })).status).toBe(409);
    expect((await getPack(mgr, id)).status).toBe(200);
  });
});
