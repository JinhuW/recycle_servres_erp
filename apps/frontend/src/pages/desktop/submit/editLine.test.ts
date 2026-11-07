import { describe, it, expect } from 'vitest';
import type { OrderLine } from '../../../lib/types';
import { partQuestionPending } from '../../../lib/ramPartQuestion';
import { orderLineToEditLine, savedLineEdits, type EditLine } from './editLine';
import { applyLinePatch, patchEditsLine, type Line } from './line';

// Samsung 16GB DDR4 RDIMM, Server, 1Rx4, 2400.
const saved = (over: Partial<OrderLine> = {}): OrderLine => ({
  id: 'l1', category: 'RAM', brand: 'Samsung', capacity: '16GB', generation: 'DDR4', type: 'Server',
  classification: 'RDIMM', rank: '1Rx4', speed: '2400', interface: null, formFactor: null,
  description: null, itemType: null, partNumber: 'M393A2K40BB1-CRC0Q', serialNumber: null,
  chipNumber: null, condition: 'Used', qty: 4, unitCost: 20, sellPrice: null, status: 'In Transit',
  scanImageId: null, scanConfidence: null, scanImageUrl: null, position: 0, health: null, rpm: null,
  ...over,
});

describe('orderLineToEditLine — the part # question on a saved line', () => {
  it('carries nothing for a line that agrees with its part #', () => {
    expect(orderLineToEditLine(saved())._partKept).toBeNull();
  });

  // The save that wrote a disagreement was the one to ask about it, so an
  // edit that leaves it as it was must not ask a second time.
  it('counts the disagreements it was saved with as answered', () => {
    const l = orderLineToEditLine(saved({ rank: '2Rx4' }));
    const repriced: EditLine = { ...l, qty: 2, unitCost: 25, _dirty: true };
    expect(partQuestionPending(l)).toBe(false);
    expect(partQuestionPending(repriced)).toBe(false);
  });

  it('asks once an edit changes a disagreement or adds one', () => {
    const l = orderLineToEditLine(saved({ rank: '2Rx4' }));
    expect(partQuestionPending({ ...l, rank: '2Rx8' })).toBe(true);
    expect(partQuestionPending({ ...l, speed: '2133' })).toBe(true);
    expect(partQuestionPending({ ...l, partNumber: 'M393A4K40BB1-CRC0Q' })).toBe(true);
  });
});

describe('patchEditsLine — what makes an edited line dirty', () => {
  it('is false for an answer the line only records', () => {
    expect(patchEditsLine({ _partKept: 'M393A2K40BB1CRC0Q|rank=2Rx4' })).toBe(false);
    expect(patchEditsLine({})).toBe(false);
  });

  it('is true once a field the save writes moves', () => {
    expect(patchEditsLine({ rank: '1Rx4' })).toBe(true);
    expect(patchEditsLine({ brand: 'Samsung', _brandNeedsConfirm: false })).toBe(true);
  });
});

// The new-PO page: a product saved by its Confirm stays editable in the
// drawer, and Submit writes back only what changed after that save.
describe('a saved product edited on the new-PO page', () => {
  const fan = (over: Partial<Line> = {}): Line => ({
    _cid: 'c1', category: 'Other', itemType: 'Fan', partNumber: 'FAN-01',
    qty: '4', unitCost: '10', condition: '', scanImageUrl: null, ...over,
  });

  it('is marked edited once a field moves', () => {
    expect(applyLinePatch(fan({ _confirmed: true, _dbId: 'l1' }), { qty: '6' })._dirty).toBe(true);
  });

  it('is not marked by its own save, by bookkeeping, or before it is saved', () => {
    // The save's own patch carries the non-`_` key `no`.
    expect(applyLinePatch(fan(), { _confirmed: true, _dbId: 'l1', no: 1 })._dirty).toBeUndefined();
    expect(applyLinePatch(fan({ _confirmed: true }), { _partKept: null })._dirty).toBeUndefined();
    expect(applyLinePatch(fan(), { qty: '6' })._dirty).toBeUndefined();
  });

  it('is written back by id, with what was edited', () => {
    const edits = savedLineEdits([
      fan({ _confirmed: true, _dbId: 'l1', qty: '6', _dirty: true }),
      fan({ _cid: 'c2', _confirmed: true, _dbId: 'l2' }),               // saved, untouched
      fan({ _cid: 'c3', qty: '2' }),                                     // not saved yet
      fan({ _cid: 'c4', _confirmed: true, _dbId: null, _dirty: true }), // saved with no id back
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ id: 'l1', qty: 6, partNumber: 'FAN-01' });
    expect(edits[0].status).toBeUndefined();
  });
});
