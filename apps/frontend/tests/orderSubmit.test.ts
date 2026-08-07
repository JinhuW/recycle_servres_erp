import { describe, it, expect } from 'vitest';
import { buildOrderSubmit } from '../src/lib/orderSubmit';
import type { DraftLine } from '../src/lib/types';

const meta = { warehouseId: 'W1', payment: 'company' as const, notes: '', otherFees: 0, otherFeesNote: null };
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  category: 'RAM', qty: 1, unitCost: 10, brand: 'Samsung', ...over,
});

describe('buildOrderSubmit — editing an existing order', () => {
  it('PATCHes the existing order and never creates a new one', () => {
    const r = buildOrderSubmit(
      { editingId: 'PO-1289', lines: [line({ id: 'l1' })], originalLineIds: ['l1'] },
      meta,
    );
    expect(r).toMatchObject({ kind: 'patch', url: '/api/orders/PO-1289' });
  });

  it('updates lines that still carry their DB id (no status, so it is preserved)', () => {
    const r = buildOrderSubmit(
      { editingId: 'PO-1', lines: [line({ id: 'l1', qty: 5 })], originalLineIds: ['l1'] },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    const lines = r.body.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'l1', qty: 5 });
    expect(lines[0]).not.toHaveProperty('status');
    expect(r.body).not.toHaveProperty('addLines');
  });

  it('a line added then autosaved (has an id, absent from originals) updates in place — never re-inserts', () => {
    // Mobile "Add item" autosaves the new line and adopts its DB id. On final
    // submit it must go to `lines` (update), not `addLines` (insert), or the
    // line would be duplicated. It is not in originalLineIds, so it must also
    // not be treated as removed.
    const r = buildOrderSubmit(
      {
        editingId: 'PO-1290',
        lines: [line({ id: 'orig1' }), line({ id: 'added-autosaved', brand: 'Crucial' })],
        originalLineIds: ['orig1'],
      },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect((r.body.lines as Array<Record<string, unknown>>).map(l => l.id)).toEqual(['orig1', 'added-autosaved']);
    expect(r.body).not.toHaveProperty('addLines');
    expect(r.body).not.toHaveProperty('removeLineIds');
  });

  it('adds lines with no id and removes originals the user deleted', () => {
    const r = buildOrderSubmit(
      {
        editingId: 'PO-1',
        lines: [line({ id: 'l1' }), line({ brand: 'Crucial' })],
        originalLineIds: ['l1', 'l2'],
      },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect((r.body.lines as unknown[])).toHaveLength(1);
    expect((r.body.addLines as Array<Record<string, unknown>>)[0]).toMatchObject({ brand: 'Crucial', status: 'In Transit' });
    expect(r.body.removeLineIds).toEqual(['l2']);
  });

  // The review screen states the goods total, it can't take one — so the only
  // value it could send is the line sum, which the backend already derives from
  // the lines in this same request. Sending it anyway read as a negotiated lot
  // price: it overwrote a PO's real one on a save that changed nothing but a
  // note, and pinned every other PO's column at whatever this screen last held.
  it('never sends totalCost — the backend derives it from the lines', () => {
    const r = buildOrderSubmit(
      { editingId: 'PO-1289', lines: [line({ id: 'l1' })], originalLineIds: ['l1'] },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.body).not.toHaveProperty('totalCost');
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

  it('does not send totalCost either — the appended lines are what derives it', () => {
    const r = buildOrderSubmit({ draftId: 'PO-9', lines: [line()] }, meta);
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.body).not.toHaveProperty('totalCost');
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

  it('does not send totalCost on a create — POST derives it from the lines', () => {
    const r = buildOrderSubmit({ lines: [line()] }, meta);
    if (r.kind !== 'create') throw new Error('expected create');
    expect(r.body).not.toHaveProperty('totalCost');
  });

  it('errors rather than creating an empty order', () => {
    const r = buildOrderSubmit({ lines: [] }, meta);
    expect(r.kind).toBe('error');
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

  it('carries RAM generation on updated lines', () => {
    const r = buildOrderSubmit(
      { editingId: 'PO-1', lines: [line({ id: 'l1', generation: 'DDR5' })], originalLineIds: ['l1'] },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect((r.body.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ generation: 'DDR5' });
  });
});
