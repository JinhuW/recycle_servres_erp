import { describe, it, expect } from 'vitest';
import { isDdr3, synthesizePartNumber } from '@recycle-erp/shared';

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

  it('replaces spaces in a component with hyphens ("M.2 2280" → "M.2-2280")', () => {
    expect(
      synthesizePartNumber('SSD', {
        brand: 'Mixed', capacity: '1.92TB', interface: 'NVMe', formFactor: 'M.2 2280',
      }),
    ).toBe('MIXED_1.92TB_NVMe_M.2-2280');
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
      synthesizePartNumber('HDD', { brand: 'Mixed', capacity: '2TB' }),
    ).toBeNull();
  });
});

// A DDR3 line needs only capacity and type, so a lot without a label part
// number is filed under those two — never under the optional brand or speed,
// or two lots filled to different depths would split.
describe('synthesizePartNumber — DDR3 RAM', () => {
  it('builds DDR3_<cap>_<type> from a DDR3 line', () => {
    expect(
      synthesizePartNumber('RAM', { generation: 'DDR3', capacity: '8GB', type: 'Server' }),
    ).toBe('DDR3_8GB_Server');
  });

  it('ignores brand, speed and class', () => {
    expect(
      synthesizePartNumber('RAM', {
        generation: 'DDR3', capacity: '16GB', type: 'Desktop', brand: 'Samsung', speed: '1600',
      }),
    ).toBe('DDR3_16GB_Desktop');
  });

  it('matches the generation case-insensitively', () => {
    expect(synthesizePartNumber('RAM', { generation: ' ddr3 ', capacity: '4GB', type: 'Laptop' }))
      .toBe('DDR3_4GB_Laptop');
  });

  it('returns null for DDR4 and DDR5, whose part number is required', () => {
    expect(synthesizePartNumber('RAM', { generation: 'DDR4', capacity: '32GB', type: 'Server' })).toBeNull();
    expect(synthesizePartNumber('RAM', { generation: 'DDR5', capacity: '32GB', type: 'Server' })).toBeNull();
    expect(synthesizePartNumber('RAM', { capacity: '32GB', type: 'Server' })).toBeNull();
  });

  it('needs both capacity and type — one alone is not yet a product', () => {
    expect(synthesizePartNumber('RAM', { generation: 'DDR3' })).toBeNull();
    expect(synthesizePartNumber('RAM', { generation: 'DDR3', capacity: '8GB' })).toBeNull();
    expect(synthesizePartNumber('RAM', { generation: 'DDR3', capacity: '8GB', type: '' })).toBeNull();
    expect(synthesizePartNumber('RAM', { generation: 'DDR3', type: 'Server' })).toBeNull();
  });
});

describe('isDdr3', () => {
  it('is true only for DDR3, whatever the case or padding', () => {
    expect(isDdr3('DDR3')).toBe(true);
    expect(isDdr3(' ddr3 ')).toBe(true);
    expect(isDdr3('DDR4')).toBe(false);
    expect(isDdr3('')).toBe(false);
    expect(isDdr3(null)).toBe(false);
    expect(isDdr3(undefined)).toBe(false);
  });
});
