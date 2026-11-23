import { describe, it, expect } from 'vitest';
import { unitFromTotal } from './lineTotal';

describe('unitFromTotal', () => {
  it('divides a typed lot total by the quantity, to the cent', () => {
    expect(unitFromTotal('250', 4)).toBe(62.5);
    expect(unitFromTotal('100', 3)).toBe(33.33);
  });
  it('gives no unit cost while the total is blank or half-typed', () => {
    expect(unitFromTotal('', 4)).toBeNull();
    expect(unitFromTotal('  ', 4)).toBeNull();
    expect(unitFromTotal('-', 4)).toBeNull();
  });
  it('gives no unit cost without a quantity to divide by', () => {
    expect(unitFromTotal('250', 0)).toBeNull();
  });
  it('accepts a zero total', () => {
    expect(unitFromTotal('0', 4)).toBe(0);
  });
});
