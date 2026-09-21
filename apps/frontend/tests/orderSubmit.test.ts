import { describe, it, expect } from 'vitest';
import { buildOrderSubmit, type SubmitState } from '../src/lib/orderSubmit';
import type { DraftLine } from '../src/lib/types';

const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  category: 'RAM', qty: 1, unitCost: 10, brand: 'Samsung', ...over,
});

describe('buildOrderSubmit — an order that already exists is not its business', () => {
  // Existing orders are edited on their detail screen, which sends only the
  // fields the user actually touched. This module knows drafts and nothing
  // else: a line with a DB id but no draftId is a line, not an order.
  it('has no branch that addresses an order by id', () => {
    const r = buildOrderSubmit({ lines: [line({ id: 'l1' })] });
    expect(r).toMatchObject({ kind: 'create', url: '/api/orders' });
  });

  it('carries a line that already has a DB id into the create as a plain line', () => {
    // A `create` only happens when no order exists, so an id here is vestigial
    // — the line still has to reach the new order.
    const r = buildOrderSubmit({ lines: [line({ id: 'l1', qty: 5 })] });
    if (r.kind !== 'create') throw new Error('expected create');
    expect((r.body.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ qty: 5 });
    expect(r.body).not.toHaveProperty('removeLineIds');
  });
});

describe('buildOrderSubmit — finalizing a new draft', () => {
  it('PATCHes the draft with only the unconfirmed lines', () => {
    const r = buildOrderSubmit(
      { draftId: 'PO-9', lines: [line({ _confirmed: true }), line({ brand: 'New' })] },
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
    const r = buildOrderSubmit({ lines: [line(), line({ brand: 'Crucial' })] });
    if (r.kind !== 'create') throw new Error('expected create');
    expect(r.url).toBe('/api/orders');
    expect((r.body.lines as unknown[])).toHaveLength(2);
  });

  it('sends every line on a create, including ones already autosaved', () => {
    // _confirmed only means "already in the draft" — with no draft, it means
    // nothing, and skipping those lines would drop them from the new order.
    const r = buildOrderSubmit({ lines: [line({ _confirmed: true }), line()] });
    if (r.kind !== 'create') throw new Error('expected create');
    expect((r.body.lines as unknown[])).toHaveLength(2);
  });

  it('errors rather than creating an empty order', () => {
    const r = buildOrderSubmit({ lines: [] });
    expect(r.kind).toBe('error');
  });
});

// The review screen holds the lines and asks nothing about the order, so a
// request from here carries lines and nothing else. It once stated warehouse,
// payment, notes and fees unconditionally — writing a "first warehouse in the
// list" default over the purchaser's own — and a goods total that read as a
// negotiated lot price. Both branches are asserted separately because they
// build their bodies separately.
describe('buildOrderSubmit — nothing but lines is sent', () => {
  const branches: [string, SubmitState, string[]][] = [
    ['finalizing a draft', { draftId: 'PO-9', lines: [line()] }, ['addLines']],
    ['creating the order outright', { lines: [line()] }, ['lines']],
  ];

  it.each(branches)('when %s', (_branch, state, keys) => {
    const r = buildOrderSubmit(state);
    if (r.kind === 'error' || r.kind === 'noop') throw new Error('expected a request');
    expect(Object.keys(r.body)).toEqual(keys);
  });
});

describe('buildOrderSubmit — line fields are not dropped', () => {
  it('carries RAM generation on added lines (purchaser-filled product info must persist)', () => {
    const r = buildOrderSubmit(
      { draftId: 'PO-9', lines: [line({ generation: 'DDR4' })] },
    );
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect((r.body.addLines as Array<Record<string, unknown>>)[0]).toMatchObject({ generation: 'DDR4' });
  });

  it('carries RAM generation on created lines', () => {
    const r = buildOrderSubmit({ lines: [line({ generation: 'DDR5' })] });
    if (r.kind !== 'create') throw new Error('expected create');
    expect((r.body.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ generation: 'DDR5' });
  });
});

// The draft path only ever appended. A line the user autosaved and then deleted
// on the review screen stayed in the draft, so the PO shipped carrying stock
// nobody bought — and order_lines IS the inventory table, so it counted.
describe('buildOrderSubmit — finalizing a new draft', () => {
  const draft = (lines: DraftLine[], originalLineIds?: string[]) =>
    buildOrderSubmit({ draftId: 'PO-1300', lines, originalLineIds });

  it('removes a line that was autosaved and then deleted', () => {
    const r = draft([line({ id: 'kept', _confirmed: true })], ['kept', 'deleted']);
    if (r.kind !== 'patch') throw new Error('expected patch');
    expect(r.body.removeLineIds).toEqual(['deleted']);
  });

  // A PATCH moves no lifecycle, so with nothing to add or remove there is
  // nothing to send — the caller lands on the PO and that is the submit.
  it('sends nothing when every line synced and none was deleted', () => {
    const r = draft([line({ id: 'a', _confirmed: true }), line({ id: 'b', _confirmed: true })], ['a', 'b']);
    expect(r).toEqual({ kind: 'noop' });
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
