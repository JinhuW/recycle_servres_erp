import { describe, it, expect } from 'vitest';
import { lineRequirements, missingFieldNames, type RequirementLine } from './lineRequirements';

// Capture, the editor and the phone form all gate on this. A disagreement here
// is what let a line be blocked on one screen and saved on another.

const ram = (over: Partial<RequirementLine> = {}): RequirementLine => ({
  category: 'RAM',
  brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'RDIMM',
  classification: 'ECC', rank: '2Rx4', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  qty: 10,
  ...over,
});

describe('lineRequirements', () => {
  it('passes a fully filled RAM line', () => {
    expect(lineRequirements(ram())).toEqual({ ready: true, missingKeys: [] });
  });

  it('names a RAM spec field the editor used to let through', () => {
    expect(lineRequirements(ram({ speed: '' })).missingKeys).toEqual(['speedMhz']);
  });

  it('lists RAM gaps in form order, qty last', () => {
    expect(lineRequirements(ram({ brand: '', rank: '', qty: 0 })).missingKeys)
      .toEqual(['brand', 'rank', 'qty']);
  });

  it('asks Micron for its chip number and other brands not at all', () => {
    expect(lineRequirements(ram({ brand: 'Micron' })).missingKeys).toEqual(['chipNumber']);
    expect(lineRequirements(ram({ chipNumber: '' })).ready).toBe(true);
  });

  it('wants only a brand from a drive', () => {
    expect(lineRequirements({ category: 'SSD', qty: 4 }).missingKeys).toEqual(['brand']);
    expect(lineRequirements({ category: 'HDD', brand: 'Seagate', qty: 4 }).ready).toBe(true);
  });

  it('wants a type and a description from an Other line', () => {
    expect(lineRequirements({ category: 'Other', qty: 1 }).missingKeys)
      .toEqual(['lfItemType', 'lfItemDescription']);
    expect(lineRequirements({ category: 'Other', itemType: 'Cable', description: 'SFF-8087', qty: 1 }).ready)
      .toBe(true);
  });

  // Blanks arrive as '' from the desktop form and null from the API, and a
  // field holding nothing but spaces is blank however it got there.
  it('treats whitespace, null and undefined alike', () => {
    expect(lineRequirements({ category: 'SSD', brand: '   ', qty: 1 }).missingKeys).toEqual(['brand']);
    expect(lineRequirements({ category: 'SSD', brand: null, qty: 1 }).missingKeys).toEqual(['brand']);
    expect(lineRequirements({ category: 'Other', itemType: ' ', description: ' ', qty: 1 }).missingKeys)
      .toEqual(['lfItemType', 'lfItemDescription']);
  });

  // The forms hold qty as a string while it is being typed, and an emptied
  // field is neither 0 nor a number.
  it('reads a typed qty, and rejects blank or zero', () => {
    expect(lineRequirements({ category: 'SSD', brand: 'Intel', qty: '12' }).ready).toBe(true);
    expect(lineRequirements({ category: 'SSD', brand: 'Intel', qty: '' }).missingKeys).toEqual(['qty']);
    expect(lineRequirements({ category: 'SSD', brand: 'Intel', qty: 0 }).missingKeys).toEqual(['qty']);
  });

  // One name per field, everywhere: "Qty" on capture and "Quantity" in the
  // editor were the same blank field described two ways.
  it('names the missing quantity with the label the drawer prints', () => {
    expect(lineRequirements({ category: 'SSD', brand: 'Intel', qty: 0 }).missingKeys)
      .toEqual(['qty']);
  });
});

describe('missingFieldNames', () => {
  const t = (k: string) => ({ brand: 'Brand', speedMhz: 'Speed (MHz)' } as Record<string, string>)[k] ?? k;

  it('joins with a comma in English and an ideographic comma in Chinese', () => {
    expect(missingFieldNames(['brand', 'speedMhz'], t, 'en')).toBe('Brand, Speed (MHz)');
    expect(missingFieldNames(['brand', 'speedMhz'], t, 'zh')).toBe('Brand、Speed (MHz)');
  });

  it('is null when nothing is missing, so callers can fall back to a generic prompt', () => {
    expect(missingFieldNames([], t, 'en')).toBeNull();
  });
});
