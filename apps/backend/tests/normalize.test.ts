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

  it('resolves speed from DDRx-NNNN notation', () => {
    expect(normalizeFields('RAM', { speed: 'DDR4-3200' }).speed).toBe('3200');
    expect(normalizeFields('RAM', { speed: 'DDR5-4800' }).speed).toBe('4800');
  });

  it('passes the PCx/DDRx number through verbatim — both label conventions', () => {
    // Modern speed-grade form: number IS the MT/s.
    expect(normalizeFields('RAM', { speed: 'PC4-3200AA' }).speed).toBe('3200');
    expect(normalizeFields('RAM', { speed: 'PC4-2666V' }).speed).toBe('2666');
    expect(normalizeFields('RAM', { speed: 'PC4-3200AA-UC0-12' }).speed).toBe('3200');
    expect(normalizeFields('RAM', { speed: 'PC4-2666V-SA1-11' }).speed).toBe('2666');
    // Legacy bandwidth form: store the bandwidth number as printed, no division.
    expect(normalizeFields('RAM', { speed: 'PC4-25600' }).speed).toBe('25600');
    expect(normalizeFields('RAM', { speed: 'PC3L-12800' }).speed).toBe('12800');
    expect(normalizeFields('RAM', { speed: 'PC5-38400' }).speed).toBe('38400');
  });

  it('normalises rank casing/spacing and reduces part number to the core SKU', () => {
    const f = normalizeFields('RAM', { rank: '2RX4', partNumber: 'PN:HMCG84AEBRA115N BB' });
    expect(f.rank).toBe('2Rx4');
    // Strip "PN:" prefix AND drop the trailing " BB" lot marker.
    expect(f.partNumber).toBe('HMCG84AEBRA115N');
  });

  it('reduces part number to the core SKU (strip suffix after first hyphen + trailing tokens)', () => {
    // Real-world SK Hynix / Samsung / Micron labels with speed-grade suffix + lot.
    expect(normalizeFields('RAM', { partNumber: 'HMAA1GU6CJR6N-XN NO AD' }).partNumber).toBe('HMAA1GU6CJR6N');
    expect(normalizeFields('RAM', { partNumber: 'M471A1K43DB1-CTD' }).partNumber).toBe('M471A1K43DB1');
    expect(normalizeFields('RAM', { partNumber: 'HMT84GL7AMR4C-RD MC AD 1420' }).partNumber).toBe('HMT84GL7AMR4C');
    expect(normalizeFields('RAM', { partNumber: 'M393A4K40DB3-CWE' }).partNumber).toBe('M393A4K40DB3');
    // No hyphen → leave alone.
    expect(normalizeFields('RAM', { partNumber: 'KCP318SD8/16' }).partNumber).toBe('KCP318SD8/16');
    expect(normalizeFields('RAM', { partNumber: 'CT16G4DFD832A' }).partNumber).toBe('CT16G4DFD832A');
    // Same rule applies cross-category.
    expect(normalizeFields('SSD', { partNumber: 'MZ7LH960HAJR-00005' }).partNumber).toBe('MZ7LH960HAJR');
    expect(normalizeFields('HDD', { partNumber: 'ST4000NM0023-1MA107' }).partNumber).toBe('ST4000NM0023');
  });

  it('drops blank/whitespace-only fields', () => {
    const f = normalizeFields('RAM', { brand: '  ', capacity: '32 GB' });
    expect(f.brand).toBeUndefined();
    expect(f.capacity).toBe('32GB');
  });

  it('is idempotent on already-clean catalog values (stub data)', () => {
    const clean = {
      brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'Server',
      classification: 'RDIMM', rank: '2Rx4', speed: '3200', partNumber: 'M393A4K40DB3',
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
