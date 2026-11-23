import { describe, it, expect } from 'vitest';
import { parseManualPrice } from './marketPrice';

describe('parseManualPrice', () => {
  it('reads a typed price', () => {
    expect(parseManualPrice('42.5')).toBe(42.5);
  });
  it('refuses a blank field rather than reading it as $0', () => {
    expect(parseManualPrice('')).toBeNull();
    expect(parseManualPrice('   ')).toBeNull();
  });
  it('refuses zero, negative and non-numeric prices', () => {
    expect(parseManualPrice('0')).toBeNull();
    expect(parseManualPrice('-3')).toBeNull();
    expect(parseManualPrice('abc')).toBeNull();
  });
});
