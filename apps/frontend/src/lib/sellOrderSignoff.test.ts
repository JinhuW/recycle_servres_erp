import { describe, it, expect } from 'vitest';
import { missingSigners, signoffSig, type SignoffLine } from './sellOrderSignoff';

const line = (over: Partial<SignoffLine> = {}): SignoffLine => ({
  inventoryId: 'lot-a', category: 'RAM', label: '32GB DDR4', subLabel: 'RDIMM',
  partNumber: 'M393A4K40CB2', condition: 'Used', qty: 2, unitPrice: 90, ...over,
});

describe('signoffSig', () => {
  const base = signoffSig([line(), line({ inventoryId: 'lot-b', qty: 1 })], 'cust-1', 'USD');

  it('ignores line order and where a lot ships from', () => {
    expect(signoffSig([line({ inventoryId: 'lot-b', qty: 1 }), line()], 'cust-1', 'USD')).toBe(base);
    // warehouseId is not part of a SignoffLine at all; extra fields don't count.
    const moved = { ...line(), warehouseId: 'WH-NJ' } as SignoffLine;
    expect(signoffSig([moved, line({ inventoryId: 'lot-b', qty: 1 })], 'cust-1', 'USD')).toBe(base);
  });

  it('changes with qty, price, the lot, the customer or the currency', () => {
    const other = line({ inventoryId: 'lot-b', qty: 1 });
    expect(signoffSig([line({ qty: 3 }), other], 'cust-1', 'USD')).not.toBe(base);
    expect(signoffSig([line({ unitPrice: 91 }), other], 'cust-1', 'USD')).not.toBe(base);
    expect(signoffSig([line({ inventoryId: 'lot-c' }), other], 'cust-1', 'USD')).not.toBe(base);
    expect(signoffSig([line(), other], 'cust-2', 'USD')).not.toBe(base);
    expect(signoffSig([line(), other], 'cust-1', 'CNY')).not.toBe(base);
  });

  it('prices to the cent, as the server stores them', () => {
    expect(signoffSig([line({ unitPrice: 90.001 }), line({ inventoryId: 'lot-b', qty: 1 })], 'cust-1', 'USD'))
      .toBe(base);
  });

  it('drops the lot of a line held at 0, as the server does', () => {
    expect(signoffSig([line({ qty: 0 })], 'c', 'USD'))
      .toBe(signoffSig([line({ qty: 0, inventoryId: null })], 'c', 'USD'));
  });
});

describe('missingSigners', () => {
  it('names the required managers without a current sign-off', () => {
    expect(missingSigners({
      complete: false,
      managers: [
        { id: '1', name: 'Jinhu', required: true, signedAt: '2026-10-08T08:00:00Z', stale: false },
        { id: '2', name: 'Tim Wu', required: true, signedAt: null, stale: false },
        { id: '3', name: 'Sofia', required: true, signedAt: '2026-10-08T08:00:00Z', stale: true },
        { id: '4', name: 'Former', required: false, signedAt: null, stale: false },
      ],
    })).toEqual(['Tim Wu', 'Sofia']);
  });
});
