import { describe, it, expect } from 'vitest';
import { fmtMoney, fmtUSD, fmtUSD0 } from './format';

// A negative amount carries its sign before the symbol; "$-120" reads as a
// typo on a chip.
describe('negative money', () => {
  it('fmtUSD puts the sign first', () => {
    expect(fmtUSD(-1240)).toBe('-$1,240.00');
    expect(fmtUSD(1240)).toBe('$1,240.00');
  });
  it('fmtUSD0 puts the sign first', () => {
    expect(fmtUSD0(-120)).toBe('-$120');
    expect(fmtUSD0(-0.4)).toBe('$0');
  });
  it('fmtMoney puts the sign first for symbols and ISO codes', () => {
    expect(fmtMoney(-78, 'CNY')).toBe('-¥78.00');
    expect(fmtMoney(-10, 'XYZ')).toBe('-XYZ 10.00');
  });
});

describe('fmtMoney', () => {
  it('formats USD with $ prefix', () => {
    expect(fmtMoney(1234.5, 'USD')).toBe('$1,234.50');
  });
  it('formats CNY with ¥ prefix', () => {
    expect(fmtMoney(78, 'CNY')).toBe('¥78.00');
  });
  it('falls back to ISO code for unknown currency', () => {
    expect(fmtMoney(10, 'XYZ')).toBe('XYZ 10.00');
  });
  it('renders em dash for null', () => {
    expect(fmtMoney(null, 'USD')).toBe('—');
  });
});
