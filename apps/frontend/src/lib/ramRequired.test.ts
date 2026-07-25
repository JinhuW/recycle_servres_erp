import { describe, expect, it } from 'vitest';
import { chipNumberRequired, missingRamFields } from './ramRequired';

const full = {
  brand: 'Micron',
  capacity: '32GB',
  generation: 'DDR4',
  type: 'RDIMM',
  classification: 'Server',
  rank: '2Rx4',
  speed: '3200',
  chipNumber: 'K4A8G085WC',
  partNumber: 'M393A4K40DB3-CWE',
};

describe('missingRamFields', () => {
  it('returns nothing for a fully-populated line', () => {
    expect(missingRamFields(full)).toEqual([]);
  });

  it('flags every field on a blank line except the brand-gated chip #', () => {
    expect(missingRamFields({})).toEqual([
      'brand', 'capacity', 'generation', 'type', 'klass',
      'rank', 'speedMhz', 'partNumber',
    ]);
  });

  it('requires chip # for Micron and Other only', () => {
    expect(missingRamFields({ ...full, chipNumber: '' })).toEqual(['chipNumber']);
    expect(missingRamFields({ ...full, brand: 'Other', chipNumber: '' })).toEqual(['chipNumber']);
    expect(missingRamFields({ ...full, brand: 'Samsung', chipNumber: '' })).toEqual([]);
    expect(missingRamFields({ ...full, brand: 'SK Hynix', chipNumber: '' })).toEqual([]);
    expect(missingRamFields({ ...full, brand: 'Kingston', chipNumber: '' })).toEqual([]);
  });

  it('treats null and whitespace-only values as missing', () => {
    expect(missingRamFields({ ...full, rank: null, speed: '  ', chipNumber: '' }))
      .toEqual(['rank', 'speedMhz', 'chipNumber']);
  });

  it('keeps display order regardless of which fields are missing', () => {
    expect(missingRamFields({ ...full, partNumber: '', brand: null }))
      .toEqual(['brand', 'partNumber']);
  });
});

describe('chipNumberRequired', () => {
  it('matches Micron and Other regardless of case or padding', () => {
    expect(chipNumberRequired('Micron')).toBe(true);
    expect(chipNumberRequired(' other ')).toBe(true);
    expect(chipNumberRequired('MICRON')).toBe(true);
  });

  it('is false for every other brand and for a blank brand', () => {
    expect(chipNumberRequired('Samsung')).toBe(false);
    expect(chipNumberRequired('')).toBe(false);
    expect(chipNumberRequired(null)).toBe(false);
    expect(chipNumberRequired(undefined)).toBe(false);
  });
});
