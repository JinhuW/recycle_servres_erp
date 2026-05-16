import { describe, it, expect } from 'vitest';
import { buildOrderSubmit } from '../src/lib/orderSubmit';
import type { DraftLine } from '../src/lib/types';

const meta = { warehouseId: 'W1', payment: 'company' as const, notes: '', totalCost: 100 };
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  category: 'RAM', qty: 1, unitCost: 10, brand: 'Samsung', ...over,
});

describe('buildOrderSubmit — editing an existing order', () => {
  it('PATCHes the existing order and never creates a new one', () => {
    const r = buildOrderSubmit(
      { editingId: 'SO-1289', category: 'RAM', lines: [line({ id: 'l1' })], originalLineIds: ['l1'] },
      meta,
    );
    expect(r).toMatchObject({ kind: 'patch', url: '/api/orders/SO-1289' });
  });

  it('updates lines that still carry their DB id (no status, so it is preserved)', () => {
    const r = buildOrderSubmit(
      { editingId: 'SO-1', category: 'RAM', lines: [line({ id: 'l1', qty: 5 })], originalLineIds: ['l1'] },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    const lines = r.body.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'l1', qty: 5 });
    expect(lines[0]).not.toHaveProperty('status');
    expect(r.body).not.toHaveProperty('addLines');
  });

  it('adds lines with no id and removes originals the user deleted', () => {
    const r = buildOrderSubmit(
      {
        editingId: 'SO-1',
        category: 'RAM',
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
});

describe('buildOrderSubmit — finalizing a new draft', () => {
  it('PATCHes the draft with only the unconfirmed lines', () => {
    const r = buildOrderSubmit(
      { draftId: 'SO-9', category: 'RAM', lines: [line({ _confirmed: true }), line({ brand: 'New' })] },
      meta,
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.url).toBe('/api/orders/SO-9');
    expect((r.body.addLines as unknown[])).toHaveLength(1);
  });

  it('errors when there is no draft and no order being edited', () => {
    const r = buildOrderSubmit({ category: 'RAM', lines: [line()] }, meta);
    expect(r.kind).toBe('error');
  });
});
