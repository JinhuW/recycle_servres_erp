import { describe, expect, it } from 'vitest';
import { inventoryEditPatch, type InventoryEditDraft } from './inventoryEditPatch';

const base: InventoryEditDraft = {
  partNumber: 'MTA18ASF1G72PZ-2G6B1QG',
  condition: 'Used',
  qty: '2',
  unitCost: '19',
  sellPrice: '30',
  status: 'Done',
  health: '',
  rpm: '',
  brand: 'Micron', capacity: '16GB', generation: 'DDR4', type: 'RDIMM',
  classification: '', rank: '', speed: '', interface: '', formFactor: '', description: '',
};

describe('inventoryEditPatch', () => {
  it('sends nothing when nothing moved', () => {
    expect(inventoryEditPatch(base, { ...base })).toEqual({});
  });

  // The prod failure: a sell-price edit on a Done PO carried the unchanged
  // qty/unitCost and status, and the closed-book guard refused the whole save.
  it('sends only the sell price when only the sell price moved', () => {
    expect(inventoryEditPatch(base, { ...base, sellPrice: '35' })).toEqual({ sellPrice: 35 });
  });

  it('reads qty and unit cost as numbers, so a reformatted value is not an edit', () => {
    expect(inventoryEditPatch(base, { ...base, qty: '2.0', unitCost: '19.00' })).toEqual({});
  });

  it('sends qty and unit cost when they really moved', () => {
    expect(inventoryEditPatch(base, { ...base, qty: '3', unitCost: '18.5' }))
      .toEqual({ qty: 3, unitCost: 18.5 });
  });

  it('clears the sell price with null', () => {
    expect(inventoryEditPatch(base, { ...base, sellPrice: '' })).toEqual({ sellPrice: null });
  });

  it('clears a spec with null and leaves the others out', () => {
    expect(inventoryEditPatch(base, { ...base, brand: '', speed: '3200' }))
      .toEqual({ brand: null, speed: '3200' });
  });

  it('sends a status change on its own', () => {
    expect(inventoryEditPatch(base, { ...base, status: 'Sold' })).toEqual({ status: 'Sold' });
  });

  it('encodes health and rpm as numbers, blank as null', () => {
    const withHealth = { ...base, health: '90', rpm: '7200' };
    expect(inventoryEditPatch(base, withHealth)).toEqual({ health: 90, rpm: 7200 });
    expect(inventoryEditPatch(withHealth, { ...withHealth, health: '', rpm: '' }))
      .toEqual({ health: null, rpm: null });
  });
});
