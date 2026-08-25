import { describe, it, expect } from 'vitest';
import {
  lineRequirements, missingFieldNames, capacityGb, ssdBrandRequired,
  type RequirementLine,
} from './lineRequirements';

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

  it('wants only a brand from an HDD', () => {
    expect(lineRequirements({ category: 'HDD', qty: 4 }).missingKeys).toEqual(['brand']);
    expect(lineRequirements({ category: 'HDD', brand: 'Seagate', qty: 4 }).ready).toBe(true);
  });

  // Small SSDs move as anonymous bulk lots; above 800GB the brand is part of
  // the line's identity and the form blocks until it's filled.
  it('asks an SSD for its brand only above 800GB', () => {
    expect(lineRequirements({ category: 'SSD', capacity: '1.92TB', qty: 4 }).missingKeys)
      .toEqual(['brand']);
    expect(lineRequirements({ category: 'SSD', capacity: '960GB', qty: 4 }).missingKeys)
      .toEqual(['brand']);
    expect(lineRequirements({ category: 'SSD', capacity: '800GB', qty: 4 }).ready).toBe(true);
    expect(lineRequirements({ category: 'SSD', capacity: '480GB', qty: 4 }).ready).toBe(true);
    expect(lineRequirements({ category: 'SSD', qty: 4 }).ready).toBe(true);
    expect(lineRequirements({ category: 'SSD', capacity: '960GB', brand: 'Intel', qty: 4 }).ready)
      .toBe(true);
  });

  it('wants a type and a part number from an Other line', () => {
    expect(lineRequirements({ category: 'Other', qty: 1 }).missingKeys)
      .toEqual(['lfItemType', 'lfPartSku']);
    expect(lineRequirements({ category: 'Other', itemType: 'Cable', partNumber: 'SFF-8087', qty: 1 }).ready)
      .toBe(true);
  });

  it('lets an Other line through without a description', () => {
    const line: RequirementLine = { category: 'Other', itemType: 'CPU', partNumber: 'i5-7500', qty: 21 };
    expect(lineRequirements({ ...line, description: '' }).ready).toBe(true);
    expect(lineRequirements({ ...line, description: null }).ready).toBe(true);
  });

  // Blanks arrive as '' from the desktop form and null from the API, and a
  // field holding nothing but spaces is blank however it got there.
  it('treats whitespace, null and undefined alike', () => {
    expect(lineRequirements({ category: 'SSD', capacity: '1.92TB', brand: '   ', qty: 1 }).missingKeys).toEqual(['brand']);
    expect(lineRequirements({ category: 'SSD', capacity: '1.92TB', brand: null, qty: 1 }).missingKeys).toEqual(['brand']);
    expect(lineRequirements({ category: 'Other', itemType: ' ', partNumber: ' ', qty: 1 }).missingKeys)
      .toEqual(['lfItemType', 'lfPartSku']);
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

describe('capacityGb / ssdBrandRequired', () => {
  it('reads the catalog capacity spellings', () => {
    expect(capacityGb('240GB')).toBe(240);
    expect(capacityGb('1.92TB')).toBe(1920);
    expect(capacityGb('7.68tb')).toBe(7680);
    expect(capacityGb(' 960 GB ')).toBe(960);
  });

  it('is null for blank or free-typed junk, which then requires no brand', () => {
    expect(capacityGb('')).toBeNull();
    expect(capacityGb(null)).toBeNull();
    expect(capacityGb('a lot')).toBeNull();
    expect(ssdBrandRequired('a lot')).toBe(false);
    expect(ssdBrandRequired(null)).toBe(false);
  });

  it('flips exactly above 800GB', () => {
    expect(ssdBrandRequired('800GB')).toBe(false);
    expect(ssdBrandRequired('801GB')).toBe(true);
    expect(ssdBrandRequired('0.8TB')).toBe(false);
    expect(ssdBrandRequired('1TB')).toBe(true);
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
