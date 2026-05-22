import { describe, it, expect, beforeEach } from 'vitest';
import { validateScan, stripUnmatched, catalogGroupFor } from './scanValidation';
import { catalog } from './lookups';

// The validator reads `catalog` directly from module state (it's populated by
// loadLookups() at boot in the real app). The tests prime it manually so each
// case has known accepted values.
function setCatalog(group: keyof typeof catalog, values: string[]) {
  const arr = catalog[group];
  arr.splice(0, arr.length, ...values);
}

describe('validateScan', () => {
  beforeEach(() => {
    // Clear everything between cases so a stale catalog from a prior test
    // can't smuggle values in.
    for (const arr of Object.values(catalog)) arr.length = 0;
  });

  it('returns no unmatched when every value is in the catalog', () => {
    setCatalog('RAM_RANK', ['1Rx4', '2Rx8']);
    setCatalog('RAM_BRAND', ['Samsung', 'Micron']);
    const r = validateScan('RAM', { rank: '2Rx8', brand: 'Samsung' });
    expect(r.unmatched).toEqual([]);
  });

  it('flags an unknown rank as unmatched', () => {
    setCatalog('RAM_RANK', ['1Rx4', '2Rx8']);
    const r = validateScan('RAM', { rank: '2Rx32' });
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0]).toMatchObject({ field: 'rank', value: '2Rx32' });
    expect(r.unmatched[0].options).toEqual(['1Rx4', '2Rx8']);
  });

  it('flags multiple unknown values in the same scan', () => {
    setCatalog('RAM_RANK', ['1Rx4']);
    setCatalog('RAM_BRAND', ['Samsung']);
    const r = validateScan('RAM', { rank: '2Rx8', brand: 'NoName', capacity: '32GB' });
    // capacity has no catalog set in this case → its group has 0 options
    // → treated as "can't verify", NOT unmatched.
    expect(r.unmatched.map(u => u.field).sort()).toEqual(['brand', 'rank']);
  });

  it('skips free-text fields (partNumber, description)', () => {
    setCatalog('RAM_RANK', ['1Rx4']);
    const r = validateScan('RAM', { partNumber: 'M393A4K40DB3-CWE', rank: '1Rx4' });
    expect(r.unmatched).toEqual([]);
  });

  it('does not flag when the catalog is empty (lookups not loaded yet)', () => {
    // Deliberately leave RAM_RANK empty: we can't say "not in list" if the
    // list itself is missing — better to stay quiet than emit a false warning.
    const r = validateScan('RAM', { rank: '2Rx32' });
    expect(r.unmatched).toEqual([]);
  });

  it('skips blank/empty values', () => {
    setCatalog('RAM_RANK', ['1Rx4']);
    const r = validateScan('RAM', { rank: '' });
    expect(r.unmatched).toEqual([]);
  });

  it('handles null/undefined extracted', () => {
    expect(validateScan('RAM', null).unmatched).toEqual([]);
    expect(validateScan('RAM', undefined).unmatched).toEqual([]);
  });

  it('Other category has no catalog-backed fields', () => {
    setCatalog('RAM_BRAND', ['Samsung']);
    const r = validateScan('Other', { description: 'Xeon Gold 6248', partNumber: 'SRF90' });
    expect(r.unmatched).toEqual([]);
  });
});

describe('stripUnmatched', () => {
  it('drops only the flagged fields', () => {
    const out = stripUnmatched(
      { brand: 'Samsung', rank: '2Rx32', capacity: '32GB' },
      [{ field: 'rank', value: '2Rx32', options: [] }],
    );
    expect(out).toEqual({ brand: 'Samsung', capacity: '32GB' });
  });

  it('returns the same object when nothing is unmatched', () => {
    const input = { brand: 'Samsung' };
    expect(stripUnmatched(input, [])).toBe(input);
  });
});

describe('catalogGroupFor', () => {
  it('maps RAM rank to RAM_RANK', () => {
    expect(catalogGroupFor('RAM', 'rank')).toBe('RAM_RANK');
  });
  it('returns null for free-text fields', () => {
    expect(catalogGroupFor('RAM', 'partNumber')).toBeNull();
  });
  it('returns null for the Other category', () => {
    expect(catalogGroupFor('Other', 'description')).toBeNull();
  });
});
