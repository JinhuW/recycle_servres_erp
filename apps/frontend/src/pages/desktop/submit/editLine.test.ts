import { describe, it, expect } from 'vitest';
import type { OrderLine } from '../../../lib/types';
import { partQuestionPending } from '../../../lib/ramPartQuestion';
import { orderLineToEditLine, type EditLine } from './editLine';
import { patchEditsLine } from './line';

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
