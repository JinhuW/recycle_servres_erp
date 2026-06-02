import { describe, it, expect } from 'vitest';
import { synthesizePartNumber } from '@recycle-erp/shared';

describe('synthesizePartNumber — SSD Mixed brand', () => {
  it('builds MIXED_<cap>_<iface>_<form> from a Mixed-brand SSD', () => {
    expect(
      synthesizePartNumber('SSD', {
        brand: 'Mixed',
        capacity: '512GB',
        interface: 'NVMe',
        formFactor: 'M.2',
      }),
    ).toBe('MIXED_512GB_NVMe_M.2');
  });

  it('skips blank components and joins only the present ones', () => {
    expect(
      synthesizePartNumber('SSD', {
        brand: 'Mixed',
        capacity: '512GB',
        interface: 'NVMe',
        formFactor: '',
      }),
    ).toBe('MIXED_512GB_NVMe');
  });

  it('strips quotes from form factor ("2.5\\"" → "2.5")', () => {
    expect(
      synthesizePartNumber('SSD', {
        brand: 'Mixed', capacity: '960GB', interface: 'SATA', formFactor: '2.5"',
      }),
    ).toBe('MIXED_960GB_SATA_2.5');
  });

  it('replaces spaces in a component with underscores ("M.2 2280" → "M.2_2280")', () => {
    expect(
      synthesizePartNumber('SSD', {
        brand: 'Mixed', capacity: '1.92TB', interface: 'NVMe', formFactor: 'M.2 2280',
      }),
    ).toBe('MIXED_1.92TB_NVMe_M.2_2280');
  });

  it('matches the Mixed brand case-insensitively', () => {
    expect(
      synthesizePartNumber('SSD', { brand: 'mixed', capacity: '1TB', interface: 'SATA' }),
    ).toBe('MIXED_1TB_SATA');
  });

  it('returns null for a non-Mixed brand', () => {
    expect(
      synthesizePartNumber('SSD', { brand: 'Samsung', capacity: '512GB', interface: 'NVMe' }),
    ).toBeNull();
  });

  it('returns null when no listed component has a value', () => {
    expect(synthesizePartNumber('SSD', { brand: 'Mixed' })).toBeNull();
  });

  it('returns null for a category with no rule', () => {
    expect(
      synthesizePartNumber('RAM', { brand: 'Mixed', capacity: '32GB' }),
    ).toBeNull();
  });
});
