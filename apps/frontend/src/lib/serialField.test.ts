import { describe, it, expect } from 'vitest';
import { addSerials, removeSerialAt, stripPending } from './serialField';

describe('addSerials', () => {
  it('seeds an empty field', () => {
    expect(addSerials('', 'SN-1')).toBe('SN-1');
    expect(addSerials(null, 'SN-1')).toBe('SN-1');
  });

  it('appends to an existing list', () => {
    expect(addSerials('SN-1', 'SN-2')).toBe('SN-1\nSN-2');
  });

  it('splits a pasted multi-value string on every separator', () => {
    expect(addSerials('', 'A\nB, C; D')).toBe('A\nB\nC\nD');
  });

  it('drops values already present', () => {
    expect(addSerials('SN-1\nSN-2', 'SN-1')).toBe('SN-1\nSN-2');
    expect(addSerials('SN-1', 'SN-1, SN-2, SN-1')).toBe('SN-1\nSN-2');
  });

  it('ignores blank input', () => {
    expect(addSerials('SN-1', '   ')).toBe('SN-1');
    expect(addSerials('SN-1', ',;\n')).toBe('SN-1');
  });

  it('normalises separators and stray whitespace already in the field', () => {
    expect(addSerials('A, B\n', 'C')).toBe('A\nB\nC');
  });
});

describe('removeSerialAt', () => {
  it('removes the first, a middle, and the last entry', () => {
    expect(removeSerialAt('A\nB\nC', 0)).toBe('B\nC');
    expect(removeSerialAt('A\nB\nC', 1)).toBe('A\nC');
    expect(removeSerialAt('A\nB\nC', 2)).toBe('A\nB');
  });

  it('empties to a string, never null', () => {
    expect(removeSerialAt('A', 0)).toBe('');
  });

  it('leaves the field alone for an out-of-range index', () => {
    expect(removeSerialAt('A\nB', 5)).toBe('A\nB');
    expect(removeSerialAt('A\nB', -1)).toBe('A\nB');
  });
});

describe('stripPending', () => {
  it('drops the uncommitted tail so it is not read as a chip', () => {
    expect(stripPending('A\nB\nSN-3', 'SN-3')).toBe('A\nB\n');
  });

  it('returns the value untouched when nothing is pending', () => {
    expect(stripPending('A\nB', '')).toBe('A\nB');
  });

  it('returns the value untouched when the tail does not match', () => {
    // Can happen for a frame after an external write (a scan append) lands.
    expect(stripPending('A\nB', 'C')).toBe('A\nB');
  });

  it('handles a field that is only pending text', () => {
    expect(stripPending('SN-1', 'SN-1')).toBe('');
  });
});
