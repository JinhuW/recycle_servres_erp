// Repro tests for lane A6d verification. Run from apps/frontend:
//   npx vitest run --root . --dir ../../docs/review-2026-10-31/repro/A6d-verify
import { describe, it, expect } from 'vitest';
import { inventoryEditPatch, type InventoryEditDraft } from '/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/apps/frontend/src/lib/inventoryEditPatch';
import { reviewMoney } from '/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/apps/frontend/src/lib/reviewPricing';
import { fmtDateShort } from '/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/apps/frontend/src/lib/format';
import { fmtEta } from '/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/apps/frontend/src/lib/shippingList';

// A6d-01: the Total cost input's handler and value expression, copied verbatim
// from pages/SubmitForm.tsx:641-648. A controlled number input re-asserts its
// value prop after each change, so what the box shows is value(next state).
function totalBox(qty: number, typed: string[]) {
  let unitCost = 0;
  const value = () => (qty * unitCost ? (qty * unitCost).toFixed(2) : '');
  const shown: string[] = [];
  let box = '';
  for (const key of typed) {
    const next = key === 'BACKSPACE' ? box.slice(0, -1) : box + key;
    const newTotal = parseFloat(next);
    if (Number.isFinite(newTotal) && qty > 0) unitCost = +(newTotal / qty).toFixed(2);
    box = value();
    shown.push(box);
  }
  return { shown, unitCost };
}

describe('A6d-01 total cost box', () => {
  it('qty 1: typing 1,5,0 never reaches 150', () => {
    const r = totalBox(1, ['1', '5', '0']);
    expect(r.shown).toEqual(['1.00', '1.00', '1.00']);
    expect(r.unitCost).toBe(1);
  });
  it('qty 3: typing 1 shows 0.99', () => {
    expect(totalBox(3, ['1']).shown).toEqual(['0.99']);
  });
  it('cannot be cleared: backspacing back to empty keeps the old total', () => {
    const r = totalBox(1, ['1', 'BACKSPACE', 'BACKSPACE', 'BACKSPACE', 'BACKSPACE', 'BACKSPACE']);
    expect(r.shown.at(-1)).toBe('1.00');
  });
});

describe('A6d-03 calendar dates in Denver', () => {
  it('runs in America/Denver', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Denver');
  });
  it('follow-up date 2026-11-03 renders as Nov 2', () => {
    expect(fmtDateShort('2026-11-03', 'en-US')).toBe('Nov 2');
  });
  it('package ETA at UTC midnight: Home says Nov 4, Shipping says Nov 5', () => {
    expect(fmtDateShort('2026-11-05T00:00:00Z', 'en-US')).toBe('Nov 4');
    expect(fmtEta('2026-11-05T00:00:00Z', 'en-US')).toContain('Nov 5');
  });
});

describe('A6d-04 inventory editor cleared unit cost', () => {
  it('sends unitCost 0', () => {
    const base: InventoryEditDraft = {
      partNumber: 'P', chipNumber: '', condition: 'Used', qty: '4', unitCost: '19',
      sellPrice: '', status: 'In Stock', health: '', rpm: '',
      brand: '', capacity: '', generation: '', type: '', classification: '',
      rank: '', speed: '', interface: '', formFactor: '', description: '',
    };
    expect(inventoryEditPatch(base, { ...base, unitCost: '' })).toEqual({ unitCost: 0 });
  });
});

describe('A6d-05 review commission vs backend projected commission', () => {
  const lines = [
    { id: 'A', qty: 4, unitCost: 10, sellPrice: 25 },
    { id: 'B', qty: 2, unitCost: 30, sellPrice: null },
    { id: 'C', qty: 1, unitCost: 5, sellPrice: 8 },
  ];
  // Mirror of apps/backend/src/lib/po-cost.ts poRealizedLateral "bought":
  // SUM((sell_price - effUnitCost) * qty), NULL sell_price drops out, and
  // services/poRealized.ts / home.ts / bankTx.ts clamp with GREATEST(.,0).
  function backend(ls: typeof lines, fees: number, rate: number) {
    const goods = ls.reduce((s, l) => s + l.qty * l.unitCost, 0);
    const pp = ls.filter(l => l.sellPrice != null)
      .reduce((s, l) => s + ((l.sellPrice as number) - (l.unitCost + fees * l.unitCost / goods)) * l.qty, 0);
    return Math.max(0, pp) * rate;
  }
  it('unpriced line: page shows -2, backend owes 30', () => {
    const m = reviewMoney({ lines, totalCost: null, otherFees: 7, commissionRate: 0.5, selfReimbursed: false });
    expect(m.commission).toBeCloseTo(-2, 6);
    expect(backend(lines, 7, 0.5)).toBeCloseTo(30, 6);
  });
  it('fully priced below cost: page negative, backend 0', () => {
    const ls = [{ id: 'A', qty: 2, unitCost: 10, sellPrice: 8 }];
    const m = reviewMoney({ lines: ls, totalCost: null, otherFees: 0, commissionRate: 0.5, selfReimbursed: false });
    expect(m.commission).toBeCloseTo(-2, 6);
    expect(backend(ls as typeof lines, 0, 0.5)).toBe(0);
  });
});
