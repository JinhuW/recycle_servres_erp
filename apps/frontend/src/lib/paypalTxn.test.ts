import { describe, it, expect } from 'vitest';
import { normalizePaypalTxnInput, isStrictPaypalTxnId } from './paypalTxn';

describe('normalizePaypalTxnInput', () => {
  it('strips whitespace and uppercases', () => {
    expect(normalizePaypalTxnInput(' 8xy12345 ab678901c ')).toBe('8XY12345AB678901C');
    expect(normalizePaypalTxnInput('8XY12345AB678901C')).toBe('8XY12345AB678901C');
    expect(normalizePaypalTxnInput('')).toBe('');
  });
});

describe('isStrictPaypalTxnId', () => {
  it('accepts exactly 17 uppercase alphanumerics', () => {
    expect(isStrictPaypalTxnId('8XY12345AB678901C')).toBe(true);
    expect(isStrictPaypalTxnId('8XY12345AB678901')).toBe(false);   // 16
    expect(isStrictPaypalTxnId('8XY12345AB678901CD')).toBe(false); // 18
    expect(isStrictPaypalTxnId('8xy12345ab678901c')).toBe(false);  // lowercase
    expect(isStrictPaypalTxnId('8XY12345-B678901C')).toBe(false);  // punctuation
  });
});
