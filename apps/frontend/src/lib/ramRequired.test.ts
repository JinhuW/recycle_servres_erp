import { describe, expect, it } from 'vitest';
import { chipNumberRequired, missingRamFields, ramFieldRequired } from './ramRequired';

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

  // DDR3 trades by capacity and module form; everything else on the label is
  // optional there, the chip # of a Micron stick included.
  it('asks a DDR3 line for capacity and type only', () => {
    expect(missingRamFields({ generation: 'DDR3', capacity: '8GB', type: 'Server' })).toEqual([]);
    expect(missingRamFields({ generation: 'DDR3', brand: 'Micron', capacity: '8GB', type: 'Server' })).toEqual([]);
    expect(missingRamFields({ generation: 'DDR3' })).toEqual(['capacity', 'type']);
    expect(missingRamFields({ generation: 'DDR3', capacity: '8GB', brand: 'Samsung', speed: '1600' }))
      .toEqual(['type']);
    expect(missingRamFields({ generation: ' ddr3 ', capacity: '8GB', type: 'Desktop' })).toEqual([]);
  });

  it('keeps the full rule for every other generation and for none yet', () => {
    expect(missingRamFields({ ...full, generation: 'DDR4', speed: '' })).toEqual(['speedMhz']);
    expect(missingRamFields({ ...full, generation: 'DDR5', brand: '' })).toEqual(['brand']);
    expect(missingRamFields({ capacity: '8GB', type: 'Server' }))
      .toEqual(['brand', 'generation', 'klass', 'rank', 'speedMhz', 'partNumber']);
  });
});

describe('ramFieldRequired', () => {
  it('stars what the save will ask for', () => {
    const ddr3 = { generation: 'DDR3', brand: 'Micron' };
    expect(ramFieldRequired(ddr3, 'capacity')).toBe(true);
    expect(ramFieldRequired(ddr3, 'type')).toBe(true);
    expect(ramFieldRequired(ddr3, 'brand')).toBe(false);
    expect(ramFieldRequired(ddr3, 'partNumber')).toBe(false);
    expect(ramFieldRequired(ddr3, 'chipNumber')).toBe(false);
    const ddr4 = { generation: 'DDR4', brand: 'Micron' };
    expect(ramFieldRequired(ddr4, 'brand')).toBe(true);
    expect(ramFieldRequired(ddr4, 'chipNumber')).toBe(true);
    expect(ramFieldRequired({ ...ddr4, brand: 'Samsung' }, 'chipNumber')).toBe(false);
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
