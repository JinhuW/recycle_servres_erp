// A RAM part number encodes most of the stick's spec, and the forms and the
// label scanner lean on that: blanks fill from it, a line that contradicts it
// is questioned at Confirm, and a label read whose part number disagrees with
// its own printed specs is corrected or sent back for a retake. Every case
// below is a part number that reached prod, with the spec the 2026-10-11
// audit settled on.

import { describe, it, expect } from 'vitest';
import {
  decodeRamPart, ramPartFill, ramPartLookalikes, ramPartMismatches, ramPartReadingsMatching,
  ramSpeedMts, reconcileRamScan, splitRamPartFamily, type RamPartSpec,
} from '@recycle-erp/shared';

const spec = (pn: string) => decodeRamPart(pn)?.spec;

describe('decodeRamPart', () => {
  it.each<[string, RamPartSpec]>([
    ['M393A2K40BB1-CRC0Q', { brand: 'Samsung', capacity: '16GB', generation: 'DDR4', classification: 'RDIMM', type: 'Server', rank: '1Rx4', speed: '2400' }],
    ['M393A4K40BB1-CRC0Q', { brand: 'Samsung', capacity: '32GB', generation: 'DDR4', classification: 'RDIMM', type: 'Server', rank: '2Rx4', speed: '2400' }],
    ['M378A1G44BB0-CWE', { brand: 'Samsung', capacity: '8GB', generation: 'DDR4', classification: 'UDIMM', type: 'Desktop', speed: '3200' }],
    ['M471A2K43DB1-CWE', { brand: 'Samsung', capacity: '16GB', generation: 'DDR4', classification: 'SODIMM', type: 'Laptop', rank: '2Rx8', speed: '3200' }],
    ['M425R2GA3BB0-CQKOL', { brand: 'Samsung', capacity: '16GB', generation: 'DDR5', classification: 'SODIMM', type: 'Laptop', rank: '1Rx8', speed: '4800' }],
    ['M386A8K40BM1-CRC4Q', { brand: 'Samsung', capacity: '64GB', generation: 'DDR4', classification: 'LRDIMM', type: 'Server', rank: '4DRx4', speed: '2400' }],
    ['M393B2G70QH0-CK0Q8', { brand: 'Samsung', capacity: '16GB', generation: 'DDR3', classification: 'RDIMM', type: 'Server', speed: '12800' }],
    ['HMA82GR7DJR4N-XN', { brand: 'SK Hynix', capacity: '16GB', generation: 'DDR4', classification: 'RDIMM', type: 'Server', rank: '1Rx4', speed: '3200' }],
    ['HMAA4GR7AJR8N-XN', { brand: 'SK Hynix', capacity: '32GB', generation: 'DDR4', classification: 'RDIMM', type: 'Server', rank: '2Rx8', speed: '3200' }],
    ['HMA82GS6JJR8N-VK', { brand: 'SK Hynix', capacity: '16GB', generation: 'DDR4', classification: 'SODIMM', type: 'Laptop', rank: '2Rx8', speed: '2666' }],
    ['HMCG88MEBRA116N', { brand: 'SK Hynix', capacity: '32GB', generation: 'DDR5', classification: 'RDIMM', type: 'Server', rank: '2Rx8' }],
    ['MTA18ASF2G72PZ-2G3B1', { brand: 'Micron', capacity: '16GB', generation: 'DDR4', classification: 'RDIMM', type: 'Server', rank: '1Rx4', speed: '2400' }],
    ['MTA18ASF2G72PDZ-2G1A1HK', { brand: 'Micron', capacity: '16GB', generation: 'DDR4', classification: 'RDIMM', type: 'Server', rank: '2Rx8', speed: '2133' }],
    ['MTA4ATF51264HZ-3G2J1', { brand: 'Micron', capacity: '4GB', generation: 'DDR4', classification: 'SODIMM', type: 'Laptop', rank: '1Rx16', speed: '3200' }],
    ['MTA9ASF1G72AZ-2G3B1ZI', { brand: 'Micron', capacity: '8GB', generation: 'DDR4', classification: 'UDIMM', rank: '1Rx8', speed: '2400' }],
    ['MTC20F2085S1RC48BA1', { brand: 'Micron', capacity: '32GB', generation: 'DDR5', classification: 'RDIMM', type: 'Server', rank: '2Rx8', speed: '4800' }],
    ['CT8G4DFD8213.C16FAR2', { capacity: '8GB', generation: 'DDR4', classification: 'UDIMM', type: 'Desktop', rank: '2Rx8', speed: '2133' }],
    ['KSM32RD4/32HDR', { brand: 'Kingston', capacity: '32GB', generation: 'DDR4', classification: 'RDIMM', type: 'Server', rank: '2Rx4', speed: '3200' }],
    ['KCP426SS6/8', { brand: 'Kingston', capacity: '8GB', generation: 'DDR4', classification: 'SODIMM', type: 'Laptop', rank: '1Rx16', speed: '2666' }],
    ['HP24D4U7S8MBP-8', { brand: 'Kingston', capacity: '8GB', generation: 'DDR4', classification: 'UDIMM', rank: '1Rx8', speed: '2400' }],
    ['F4-3200C16D-32GVK', { capacity: '16GB', generation: 'DDR4', speed: '3200' }],
    ['F4-3200C22D-64GRS', { capacity: '32GB', generation: 'DDR4', classification: 'SODIMM', type: 'Laptop', speed: '3200' }],
    ['CMK16GX4M2B3000C15', { capacity: '8GB', generation: 'DDR4', speed: '3000' }],
  ])('%s', (pn, want) => {
    expect(spec(pn)).toEqual(want);
  });

  it('leaves out what the number does not fix rather than guessing', () => {
    // A DDR4 RDIMM with four x4 ranks is a 3DS stack the number doesn't spell out.
    expect(spec('M393A8K40B22-CWD6Y')?.rank).toBeUndefined();
    // An ECC UDIMM goes in a desktop or a server.
    expect(spec('MTA9ASF1G72AZ-2G3B1')?.type).toBeUndefined();
  });

  it('decodes nothing from OEM numbers that carry no spec', () => {
    expect(decodeRamPart('9995711-008.A00G')).toBeNull();
    expect(decodeRamPart('KKRVFX-HYC')).toBeNull();
    expect(decodeRamPart('')).toBeNull();
    expect(decodeRamPart(null)).toBeNull();
  });

  it('marks the family a label groups by', () => {
    const d = decodeRamPart('M393A2K40BB1-CRC0Q')!;
    expect(splitRamPartFamily('M393A2K40BB1-CRC0Q', d.familyLength)).toEqual(['M393A2K40', 'BB1-CRC0Q']);
    expect(splitRamPartFamily('PN: M393-A2K40BB1', 9)).toEqual(['PN: M393-A2K40', 'BB1']);
  });

  it('compares a DDR3 PC3 rate and its MT/s as one speed', () => {
    expect(ramSpeedMts('12800')).toBe('1600');
    expect(ramSpeedMts('PC3-12800')).toBe('1600');
    expect(ramPartMismatches(decodeRamPart('M393B2G70QH0-CK0Q8'), { speed: '1600' })).toEqual([]);
  });
});

describe('misread part numbers', () => {
  it('decodes one look-alike away when the number as written takes no scheme', () => {
    const d = decodeRamPart('MTA36ASF2G72PZ-266E1RI')!;
    expect(d.readAs).toBe('MTA36ASF2G72PZ-2G6E1RI');
    expect(d.spec.speed).toBe('2666');
  });

  it('prefers a reading that decodes more over one that decodes less', () => {
    // The O in 4O still matches Samsung's shape, minus the rank.
    const d = decodeRamPart('M393A2K4OBB1-CRC0Q')!;
    expect(d.readAs).toBe('M393A2K40BB1-CRC0Q');
    expect(d.spec.rank).toBe('1Rx4');
  });

  it('offers the readings that would agree with the form', () => {
    // HMAA read as HMA8: 8Gb dies make a 32GB x8 module four-rank.
    const line = { capacity: '32GB', rank: '2Rx8', generation: 'DDR4', classification: 'RDIMM' };
    expect(ramPartMismatches(decodeRamPart('HMA84GR7AJR8N-XN'), line).map(m => m.field)).toEqual(['rank']);
    expect(ramPartReadingsMatching('HMA84GR7AJR8N-XN', line)).toContain('HMAA4GR7AJR8N-XN');
  });

  it("never offers a reading that agrees only by decoding less", () => {
    expect(ramPartReadingsMatching('MT36JSF2G72PZ-1G6E1HE', { speed: '14900' })).toEqual([]);
  });

  it('tries Micron single vs dual rank', () => {
    expect(ramPartLookalikes('MTA18ASF2G72PZ-2G3B1')).toContain('MTA18ASF2G72PDZ-2G3B1');
    expect(ramPartLookalikes('MTA18ASF2G72PDZ-2G3B1')).toContain('MTA18ASF2G72PZ-2G3B1');
  });
});

describe('ramPartFill / ramPartMismatches', () => {
  it('fills only blanks and questions only named values', () => {
    const d = decodeRamPart('M393A2K40BB1-CRC0Q');
    const line = { brand: 'Samsung', capacity: '16GB', rank: '2Rx4', speed: '' };
    expect(ramPartFill(d, line)).toEqual({ generation: 'DDR4', classification: 'RDIMM', type: 'Server', speed: '2400' });
    expect(ramPartMismatches(d, line)).toEqual([{ field: 'rank', partSays: '1Rx4', lineSays: '2Rx4' }]);
  });
});

describe('reconcileRamScan', () => {
  const read = {
    brand: 'SK Hynix', capacity: '32GB', generation: 'DDR4', type: 'Server',
    classification: 'RDIMM', rank: '2Rx8', speed: '3200',
  };

  it('agrees: nothing to report beyond the blanks it filled', () => {
    const { fields, check } = reconcileRamScan({ partNumber: 'HMAA4GR7AJR8N-XN', ...read, speed: '' });
    expect(fields.speed).toBe('3200');
    expect(check).toEqual({ filled: ['speed'], conflicts: [] });
  });

  it('corrects a part number one misread away when the printed specs agree with the fix', () => {
    const { fields, check } = reconcileRamScan({ partNumber: 'HMA84GR7AJR8N-XN', ...read });
    expect(fields.partNumber).toBe('HMAA4GR7AJR8N-XN');
    expect(check?.partCorrected).toEqual({ from: 'HMA84GR7AJR8N-XN', to: 'HMAA4GR7AJR8N-XN' });
    expect(check?.conflicts).toEqual([]);
  });

  it('reports, and leaves alone, a contradiction no single misread explains', () => {
    const { fields, check } = reconcileRamScan({ partNumber: 'HMAA4GR7AJR8N-XN', ...read, capacity: '16GB', rank: '1Rx4' });
    expect(fields.capacity).toBe('16GB');
    expect(fields.partNumber).toBe('HMAA4GR7AJR8N-XN');
    expect(check?.conflicts.map(m => m.field).sort()).toEqual(['capacity', 'rank']);
  });

  it('has nothing to say about a label without a decodable part number', () => {
    expect(reconcileRamScan({ ...read }).check).toBeNull();
    expect(reconcileRamScan({ partNumber: '9995711-008.A00G', ...read }).check).toBeNull();
  });
});
