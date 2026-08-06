import { describe, it, expect } from 'vitest';
import { switchLineCategory, clearedBySwitch } from './lineCategorySwitch';

const ramLine = {
  category: 'RAM' as const,
  brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'Server',
  classification: 'RDIMM', rank: '2Rx4', speed: '3200', chipNumber: 'K4A8G085WB',
  partNumber: 'M393A4K40DB3-CWE', serialNumber: 'SN-1', condition: 'Pulled — Tested',
  qty: 4, unitCost: 78.5, sellPrice: 96,
};

describe('switchLineCategory', () => {
  it('clears the fields the old category owned', () => {
    const patch = switchLineCategory(ramLine, 'SSD');
    expect(patch.category).toBe('SSD');
    expect(patch).toMatchObject({
      generation: null, type: null, classification: null, rank: null,
      speed: null, chipNumber: null,
    });
  });

  it('keeps the fields the new category also owns', () => {
    const patch = switchLineCategory(ramLine, 'SSD');
    expect(patch).not.toHaveProperty('brand');
    expect(patch).not.toHaveProperty('capacity');
  });

  it('never clears category-agnostic fields', () => {
    const patch = switchLineCategory(ramLine, 'Other');
    for (const keep of ['partNumber', 'serialNumber', 'condition', 'qty', 'unitCost', 'sellPrice']) {
      expect(patch).not.toHaveProperty(keep);
    }
  });

  it('only names fields that actually held a value', () => {
    const sparse = { category: 'RAM' as const, brand: 'Samsung', speed: '' };
    const patch = switchLineCategory(sparse, 'HDD');
    expect(patch).not.toHaveProperty('speed');       // was blank
    expect(patch).not.toHaveProperty('generation');  // was absent
  });

  it('does not resurrect the old fields on the way back', () => {
    const asSsd = { ...ramLine, ...switchLineCategory(ramLine, 'SSD') };
    const back = { ...asSsd, ...switchLineCategory(asSsd, 'RAM') };
    expect(back.generation).toBeNull();
    expect(back.speed).toBeNull();
  });
});

describe('clearedBySwitch', () => {
  it('lists what the undo notice has to name', () => {
    const cleared = clearedBySwitch(ramLine, 'SSD');
    expect(cleared).toContain('generation');
    expect(cleared).toContain('speed');
    expect(cleared).not.toContain('brand');
    expect(cleared).not.toContain('partNumber');
  });

  it('is empty when nothing would be lost', () => {
    expect(clearedBySwitch({ category: 'RAM', brand: 'Samsung' }, 'SSD')).toEqual([]);
  });
});
