import { describe, it, expect } from 'vitest';
import { fmtMoney } from './format';

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
