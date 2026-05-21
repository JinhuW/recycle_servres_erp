import { describe, it, expect } from 'vitest';
import { normalizeFields } from '../src/ai/normalize';

describe('normalizeFields — RAM', () => {
  it('strips the space the prompt induced in capacity ("32 GB" → "32GB")', () => {
    expect(normalizeFields('RAM', { capacity: '32 GB' }).capacity).toBe('32GB');
    expect(normalizeFields('RAM', { capacity: '8 gb' }).capacity).toBe('8GB');
    expect(normalizeFields('RAM', { capacity: '16G' }).capacity).toBe('16GB');
  });

  it('recovers the type/generation confusion (type="DDR5", generation missing)', () => {
    const f = normalizeFields('RAM', { type: 'DDR5', classification: 'RDIMM' });
    expect(f.generation).toBe('DDR5');
    expect(f.type).toBe('Server'); // derived from RDIMM
  });

  it('keeps a valid device type and still normalises generation', () => {
    const f = normalizeFields('RAM', { type: 'Laptop', generation: 'ddr 4', classification: 'SODIMM' });
    expect(f.type).toBe('Laptop');
    expect(f.generation).toBe('DDR4');
  });

  it('derives device type from classification when absent', () => {
    expect(normalizeFields('RAM', { classification: 'UDIMM' }).type).toBe('Desktop');
    expect(normalizeFields('RAM', { classification: 'sodimm' }).classification).toBe('SODIMM');
  });

  it('reduces speed to the bare MT/s number', () => {
    expect(normalizeFields('RAM', { speed: '4800 MT/s' }).speed).toBe('4800');
    expect(normalizeFields('RAM', { speed: '3200MHz' }).speed).toBe('3200');
  });

  it('normalises rank casing/spacing and strips PN: prefix', () => {
    const f = normalizeFields('RAM', { rank: '2RX4', partNumber: 'PN:HMCG84AEBRA115N BB' });
    expect(f.rank).toBe('2Rx4');
    expect(f.partNumber).toBe('HMCG84AEBRA115N BB');
  });

  it('drops blank/whitespace-only fields', () => {
    const f = normalizeFields('RAM', { brand: '  ', capacity: '32 GB' });
    expect(f.brand).toBeUndefined();
    expect(f.capacity).toBe('32GB');
  });

  it('is idempotent on already-clean catalog values (stub data)', () => {
    const clean = {
      brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'Server',
      classification: 'RDIMM', rank: '2Rx4', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
    };
    expect(normalizeFields('RAM', clean)).toEqual(clean);
  });
});

describe('normalizeFields — SSD/HDD', () => {
  it('canonicalises capacity and interface', () => {
    const f = normalizeFields('SSD', { capacity: '1.92 TB', interface: 'nvme' });
    expect(f.capacity).toBe('1.92TB');
    expect(f.interface).toBe('NVMe');
  });
  it('reduces rpm to digits', () => {
    expect(normalizeFields('HDD', { rpm: '7200 RPM' }).rpm).toBe('7200');
  });
});
