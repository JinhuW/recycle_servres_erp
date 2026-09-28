import { describe, it, expect } from 'vitest';
import { chipFillQuery, type ChipFillMemory } from './useChipFill';

// The gate decides whether a line is filled at all, and every "don't write
// here" rule lives in it. The hook around it needs a renderer; this doesn't.

const fresh: ChipFillMemory = { mountPart: '', answeredFor: null, autoFilled: null };
const ram = (partNumber: string, chipNumber = '') => ({ category: 'RAM', partNumber, chipNumber });

describe('chipFillQuery', () => {
  it('asks under the canonical part number', () => {
    expect(chipFillQuery(ram('m393a4k40db3-cwe'), fresh)).toBe('M393A4K40DB3CWE');
    expect(chipFillQuery(ram('P/N: MTA36 ASF4G72PZ'), fresh)).toBe('MTA36ASF4G72PZ');
  });

  it('only fills RAM lines, and never a read-only one', () => {
    expect(chipFillQuery({ ...ram('MZ7LH960HAJR'), category: 'SSD' }, fresh)).toBe('');
    expect(chipFillQuery(ram('M393A4K40DB3-CWE'), fresh, false)).toBe('');
  });

  it('waits for a part number long enough not to match by accident', () => {
    expect(chipFillQuery(ram('M393'), fresh)).toBe('');
    expect(chipFillQuery(ram('M393A4'), fresh)).toBe('M393A4');
  });

  it('leaves the part number a line opened with alone', () => {
    const mem = { ...fresh, mountPart: 'M393A4K40DB3CWE' };
    expect(chipFillQuery(ram('M393A4K40DB3-CWE'), mem)).toBe('');
    expect(chipFillQuery(ram('M393A4K40DB3-CWF'), mem)).toBe('M393A4K40DB3CWF');
  });

  it('never replaces a chip the user typed', () => {
    expect(chipFillQuery(ram('M393A4K40DB3-CWE', 'K4A8G085WC'), fresh)).toBe('');
  });

  it('replaces its own fill when the part number moves on', () => {
    const mem = { ...fresh, answeredFor: 'M393A4K40DB', autoFilled: 'D9XPF' };
    expect(chipFillQuery(ram('M393A4K40DB3-CWE', 'D9XPF'), mem)).toBe('M393A4K40DB3CWE');
  });

  it('asks about a part number once, so a cleared fill stays cleared', () => {
    const mem = { ...fresh, answeredFor: 'M393A4K40DB3CWE' };
    expect(chipFillQuery(ram('M393A4K40DB3-CWE'), mem)).toBe('');
  });
});
