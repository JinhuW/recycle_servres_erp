import { describe, it, expect } from 'vitest';
import { parseSerials } from './SerialNumbers';

describe('parseSerials', () => {
  it('returns [] for null / undefined / empty', () => {
    expect(parseSerials(null)).toEqual([]);
    expect(parseSerials(undefined)).toEqual([]);
    expect(parseSerials('')).toEqual([]);
    expect(parseSerials('   \n  ')).toEqual([]);
  });

  it('splits on newlines and trims each entry', () => {
    expect(parseSerials('SN-1\nSN-2\n  SN-3 ')).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });

  it('also splits on commas and semicolons', () => {
    expect(parseSerials('A, B; C')).toEqual(['A', 'B', 'C']);
  });

  it('drops blank lines from collapsed separators', () => {
    expect(parseSerials('A\n\n\nB\n')).toEqual(['A', 'B']);
  });
});
