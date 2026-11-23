import { describe, it, expect } from 'vitest';
import { roundedLotTotal, unitFromTotal } from './lineTotal';

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

describe('roundedLotTotal', () => {
  it('names what a total the cent cannot split saves as', () => {
    expect(roundedLotTotal('100', 3)).toEqual({ unit: 33.33, saved: 99.99 });
    expect(roundedLotTotal('200', 3)).toEqual({ unit: 66.67, saved: 200.01 });
  });
  it('is null when the total saves as typed', () => {
    expect(roundedLotTotal('250', 4)).toBeNull();
    expect(roundedLotTotal('99.99', 3)).toBeNull();
    expect(roundedLotTotal('0.3', 3)).toBeNull();
  });
  it('is null with no unit cost to derive yet', () => {
    expect(roundedLotTotal('', 3)).toBeNull();
    expect(roundedLotTotal('100', 0)).toBeNull();
  });
});
