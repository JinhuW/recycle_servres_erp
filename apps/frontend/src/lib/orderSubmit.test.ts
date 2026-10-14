import { describe, it, expect } from 'vitest';
import { buildOrderSubmit } from './orderSubmit';
import type { DraftLine } from './types';

const line = (over: Partial<DraftLine>): DraftLine => ({
  category: 'RAM', label: 'x', qty: 1, unitCost: 5, _cid: Math.random().toString(36).slice(2), ...over,
} as DraftLine);

describe('buildOrderSubmit', () => {
  it('appends only the lines not yet autosaved', () => {
    const req = buildOrderSubmit({ draftId: 'PO-1', lines: [line({ id: 'a', _confirmed: true }), line({})] });
    expect(req.kind).toBe('patch');
    if (req.kind !== 'patch') return;
    expect((req.body.addLines as unknown[]).length).toBe(1);
    expect(req.body.lines).toBeUndefined();
  });

  // Review held the edited line as confirmed, so Submit filtered it out and
  // returned noop: the new cost never reached the server.
  it('retries a confirmed line whose later edit failed, by id, and never as a second insert', () => {
    const req = buildOrderSubmit({
      draftId: 'PO-1',
      lines: [line({ id: 'a', _confirmed: true, _dirty: true, unitCost: 7 })],
      originalLineIds: ['a'],
    });
    expect(req.kind).toBe('patch');
    if (req.kind !== 'patch') return;
    expect(req.body.addLines).toBeUndefined();
    expect(req.body.removeLineIds).toBeUndefined();
    const edits = req.body.lines as Array<{ id: string; unitCost: number; status?: string }>;
    expect(edits).toHaveLength(1);
    expect(edits[0].id).toBe('a');
    expect(edits[0].unitCost).toBe(7);
    expect(edits[0].status).toBeUndefined();
  });

  it('is a noop once every line is saved and clean', () => {
    expect(buildOrderSubmit({ draftId: 'PO-1', lines: [line({ id: 'a', _confirmed: true })], originalLineIds: ['a'] }))
      .toEqual({ kind: 'noop' });
  });

  it('names a line deleted after it autosaved', () => {
    const req = buildOrderSubmit({ draftId: 'PO-1', lines: [], originalLineIds: ['a'] });
    expect(req).toMatchObject({ kind: 'patch', body: { removeLineIds: ['a'] } });
  });
});
