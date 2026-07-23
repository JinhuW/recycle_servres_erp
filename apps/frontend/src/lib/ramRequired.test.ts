import { describe, expect, it } from 'vitest';
import { missingRamFields } from './ramRequired';

const full = {
  brand: 'Samsung',
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

  it('flags every field on a blank line', () => {
    expect(missingRamFields({})).toEqual([
      'brand', 'capacity', 'generation', 'type', 'klass',
      'rank', 'speedMhz', 'chipNumber', 'partNumber',
    ]);
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
