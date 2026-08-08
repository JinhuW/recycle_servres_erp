import { describe, it, expect } from 'vitest';
import { buildOrderSubmit, type SubmitState } from '../src/lib/orderSubmit';
import type { DraftLine } from '../src/lib/types';

const meta = { warehouseId: 'W1', payment: 'company' as const, notes: '', otherFees: 0, otherFeesNote: null };
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  category: 'RAM', qty: 1, unitCost: 10, brand: 'Samsung', ...over,
});

describe('buildOrderSubmit — an order that already exists is not its business', () => {
  // This module states all five meta fields on every request, which is only
  // safe when the user has just been asked for them. Routing an existing order
  // through here re-asked on a blank review screen and wrote the defaults back:
  // a PO saved as HK2 / self-paid / "supplier ref 4471" returned as
  // warehouses[0] / company / no notes. Existing orders are edited on their
  // detail screen now, which sends only the fields the user actually touched.
  it('has no branch that addresses an order by id', () => {
    const r = buildOrderSubmit({ lines: [line({ id: 'l1' })] }, meta);
    expect(r).toMatchObject({ kind: 'create', url: '/api/orders' });
  });

  it('carries a line that already has a DB id into the create as a plain line', () => {
    // A `create` only happens when no order exists, so an id here is vestigial
    // — the line still has to reach the new order.
    const r = buildOrderSubmit({ lines: [line({ id: 'l1', qty: 5 })] }, meta);
    if (r.kind !== 'create') throw new Error('expected create');
    expect((r.body.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ qty: 5 });
    expect(r.body).not.toHaveProperty('removeLineIds');
  });
});

describe('buildOrderSubmit — finalizing a new draft', () => {
  it('PATCHes the draft with only the unconfirmed lines', () => {
    const r = buildOrderSubmit(
      { draftId: 'PO-9', lines: [line({ _confirmed: true }), line({ brand: 'New' })] },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.url).toBe('/api/orders/PO-9');
    expect((r.body.addLines as unknown[])).toHaveLength(1);
  });

  // The order row is created by the first line that can be persisted, so a
  // session whose lines were all held back arrives here with nothing to PATCH.
  // One atomic create is also what keeps an invalid line from leaving an empty
  // PO behind.
  it('creates the order outright when none exists yet', () => {
    const r = buildOrderSubmit({ lines: [line(), line({ brand: 'Crucial' })] }, meta);
    if (r.kind !== 'create') throw new Error('expected create');
    expect(r.url).toBe('/api/orders');
    expect((r.body.lines as unknown[])).toHaveLength(2);
    expect(r.body.warehouseId).toBe(meta.warehouseId);
  });

  it('sends every line on a create, including ones already autosaved', () => {
    // _confirmed only means "already in the draft" — with no draft, it means
    // nothing, and skipping those lines would drop them from the new order.
    const r = buildOrderSubmit({ lines: [line({ _confirmed: true }), line()] }, meta);
    if (r.kind !== 'create') throw new Error('expected create');
    expect((r.body.lines as unknown[])).toHaveLength(2);
  });

  it('errors rather than creating an empty order', () => {
    const r = buildOrderSubmit({ lines: [] }, meta);
    expect(r.kind).toBe('error');
  });
});

// The review screen states the goods total, it can't take one — so the only
// value it could send is the line sum, which the backend already derives from
// the lines in this same request. Sending it anyway read as a negotiated lot
// price: it overwrote a PO's real one on a save that changed nothing but a
// note, and pinned every other PO's column at whatever this screen last held.
//
// Both branches spread one `metaBody`, so this is a single line of source
// — but each branch is asserted, because that shared literal is exactly what a
// future edit could stop sharing.
describe('buildOrderSubmit — totalCost is never sent', () => {
  const branches: [string, SubmitState][] = [
    ['finalizing a draft', { draftId: 'PO-9', lines: [line()] }],
    ['creating the order outright', { lines: [line()] }],
  ];

  it.each(branches)('omits it when %s', (_branch, state) => {
    const r = buildOrderSubmit(state, meta);
    if (r.kind === 'error') throw new Error('expected a request');
    expect(r.body).not.toHaveProperty('totalCost');
  });
});

describe('buildOrderSubmit — line fields are not dropped', () => {
  it('carries RAM generation on added lines (purchaser-filled product info must persist)', () => {
    const r = buildOrderSubmit(
      { draftId: 'PO-9', lines: [line({ generation: 'DDR4' })] },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect((r.body.addLines as Array<Record<string, unknown>>)[0]).toMatchObject({ generation: 'DDR4' });
  });

  it('carries RAM generation on created lines', () => {
    const r = buildOrderSubmit({ lines: [line({ generation: 'DDR5' })] }, meta);
    if (r.kind !== 'create') throw new Error('expected create');
    expect((r.body.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ generation: 'DDR5' });
  });
});

// The draft path only ever appended. A line the user autosaved and then deleted
// on the review screen stayed in the draft, so the PO shipped carrying stock
// nobody bought — and order_lines IS the inventory table, so it counted.
describe('buildOrderSubmit — finalizing a new draft', () => {
  const draft = (lines: DraftLine[], originalLineIds?: string[]) =>
    buildOrderSubmit({ draftId: 'PO-1300', lines, originalLineIds }, meta);

  it('removes a line that was autosaved and then deleted', () => {
    const r = draft([line({ id: 'kept', _confirmed: true })], ['kept', 'deleted']);
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.body.removeLineIds).toEqual(['deleted']);
  });

  it('sends no removeLineIds when nothing was deleted', () => {
    const r = draft([line({ id: 'a', _confirmed: true }), line({ id: 'b', _confirmed: true })], ['a', 'b']);
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.body).not.toHaveProperty('removeLineIds');
  });

  it('never names an unsaved line as removed — it was never in the draft', () => {
    const r = draft([line({ _cid: 'c1' })], []);
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.body).not.toHaveProperty('removeLineIds');
    expect(r.body.addLines).toHaveLength(1);
  });

  it('appends the unsaved lines and removes the deleted ones in one request', () => {
    const r = draft([line({ id: 'kept', _confirmed: true }), line({ _cid: 'new' })], ['kept', 'gone']);
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.body.removeLineIds).toEqual(['gone']);
    expect(r.body.addLines).toHaveLength(1);
  });
});
