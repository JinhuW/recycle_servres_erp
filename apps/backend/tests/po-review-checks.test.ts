// The AI review's verdict on one line, from its witnesses: the decoded part
// number, the label read, the web and the market. Two witnesses against the
// line is an error, one a warning; a decode the label contradicts points at
// the part number, not the spec.

import { describe, it, expect } from 'vitest';
import {
  checkLine, findingIsCurrent, needsWebLookup, type LabelRead, type ReviewLine,
} from '../src/services/poReviewChecks';

// M393A4K40BB1-CRC0Q decodes to Samsung 32GB DDR4 RDIMM Server 2Rx4 2400.
const PN = 'M393A4K40BB1-CRC0Q';

function ram(over: Partial<ReviewLine> = {}): ReviewLine {
  return {
    id: 'l1', productNo: 1, category: 'RAM', brand: 'Samsung', capacity: '32GB', generation: 'DDR4',
    type: 'Server', classification: 'RDIMM', rank: '2Rx4', speed: '2400', interface: null,
    formFactor: null, rpm: null, partNumber: PN, qty: 4, unitCost: 50, ...over,
  };
}
const label = (fields: Record<string, string>): LabelRead => ({ fields, read: 'reread', url: 'https://x/y.jpg' });

describe('checkLine (RAM)', () => {
  it('finds nothing on a line that agrees with its part number', () => {
    expect(checkLine(ram())).toEqual([]);
  });

  it('warns when the part number alone contradicts a spec', () => {
    const f = checkLine(ram({ capacity: '16GB' })).find((x) => x.field === 'capacity');
    expect(f).toMatchObject({ severity: 'warn', code: 'spec_mismatch', currentValue: '16GB', suggestedValue: '32GB' });
  });

  it('is an error when the part number and the label agree against the line', () => {
    const f = checkLine(ram({ rank: '1Rx4' }), { label: label({ rank: '2Rx4' }) }).find((x) => x.field === 'rank');
    expect(f).toMatchObject({ severity: 'error', suggestedValue: '2Rx4' });
    expect(f!.sources.map((s) => s.kind)).toEqual(['decoder', 'label']);
  });

  it('does not flag a spec the label backs against the decode', () => {
    const out = checkLine(ram({ rank: '1Rx4' }), { label: label({ rank: '1Rx4' }) });
    expect(out.filter((x) => x.code === 'spec_mismatch')).toEqual([]);
  });

  it('reads a DDR3 PC3 rating and its MT/s as the same speed', () => {
    const ddr3 = ram({ partNumber: 'M393B2G70QH0-CK0Q8', capacity: '16GB', generation: 'DDR3', rank: null, speed: '12800' });
    expect(checkLine(ddr3).filter((x) => x.field === 'speed')).toEqual([]);
    expect(checkLine({ ...ddr3, speed: '1600' }).filter((x) => x.field === 'speed')).toEqual([]);
  });

  it('suggests what the part number says for a blank field', () => {
    const f = checkLine(ram({ rank: null })).find((x) => x.field === 'rank');
    expect(f).toMatchObject({ severity: 'info', code: 'spec_blank', suggestedValue: '2Rx4' });
  });

  it('raises a label part number that differs from the stored one', () => {
    const f = checkLine(ram({ partNumber: 'M393A2K40BB1-CRC0Q' }), { label: label({ partNumber: PN }) })
      .find((x) => x.code === 'pn_label_differs');
    // The label's part number fits the line's specs; the stored one does not.
    expect(f).toMatchObject({ severity: 'error', field: 'partNumber', suggestedValue: PN });
  });

  it('blames a misread part number, not the specs it would rewrite', () => {
    // HMAA read as HMA8: the misread decodes to 4Rx4, the line is a 2Rx4 stick.
    const hynix = ram({
      brand: 'SK Hynix', capacity: '64GB', rank: '2Rx4', speed: '3200', partNumber: 'HMA88GR7AJR4N-XN',
    });
    const out = checkLine(hynix);
    expect(out.filter((x) => x.code === 'spec_mismatch')).toEqual([]);
    expect(out.find((x) => x.code === 'pn_misread')).toMatchObject({
      field: 'partNumber', suggestedValue: 'HMAA8GR7AJR4N-XN',
    });
  });

  it('notes a line with no part number', () => {
    expect(checkLine(ram({ partNumber: null }))[0]).toMatchObject({ code: 'pn_missing', severity: 'info' });
  });

  it('compares an undecodable part number with the web', () => {
    const odd = ram({ partNumber: '9995ABC-XYZ', brand: 'Kingston' });
    expect(needsWebLookup(odd, false)).toBe(true);
    const f = checkLine(odd, { web: { specs: { capacity: '16GB' }, sourceUrls: ['https://k/x'] } })
      .find((x) => x.field === 'capacity');
    expect(f).toMatchObject({ severity: 'warn', suggestedValue: '16GB' });
    expect(f!.sources[0]).toMatchObject({ kind: 'web', urls: ['https://k/x'] });
  });
});

describe('checkLine (drives and cost)', () => {
  const ssd: ReviewLine = {
    ...ram(), category: 'SSD', brand: 'Samsung', capacity: '960GB', generation: null, type: null,
    classification: null, rank: null, speed: null, interface: 'SATA', formFactor: '2.5"',
    partNumber: 'MZ7LH960HAJR-00005',
  };

  it('looks a drive up only when no label read checks it', () => {
    expect(needsWebLookup(ssd, false)).toBe(true);
    expect(needsWebLookup(ssd, true)).toBe(false);
  });

  it('never looks up a placeholder or a Mixed lot\'s synthetic part number', () => {
    expect(needsWebLookup({ ...ssd, partNumber: 'N/A' }, false)).toBe(false);
    const mixed = { ...ssd, brand: 'Mixed', capacity: '960GB', interface: 'SATA', formFactor: '2.5"' };
    expect(needsWebLookup({ ...mixed, partNumber: 'MIXED_960GB_SATA_2.5' }, false)).toBe(false);
  });

  it('warns on a label that disagrees, errors when the web agrees with it', () => {
    const lab = label({ capacity: '1.92TB' });
    expect(checkLine(ssd, { label: lab }).find((x) => x.field === 'capacity')).toMatchObject({ severity: 'warn' });
    expect(checkLine(ssd, { label: lab, web: { specs: { capacity: '1.92TB' }, sourceUrls: ['https://a'] } })
      .find((x) => x.field === 'capacity')).toMatchObject({ severity: 'error', suggestedValue: '1.92TB' });
  });

  it('flags a line with no cost, and one paid above market', () => {
    expect(checkLine({ ...ssd, unitCost: 0 }).map((x) => x.code)).toContain('cost_missing');
    const f = checkLine(ssd, { market: { value: 40, label: 'Samsung 960GB' } }).find((x) => x.code === 'above_market');
    expect(f).toMatchObject({ severity: 'info', field: null });
  });
});

describe('findingIsCurrent', () => {
  it('lets a cost finding go stale once the unit cost moves', () => {
    const f = { field: null, code: 'cost_missing', currentValue: '0' };
    expect(findingIsCurrent(f, { unitCost: 0 })).toBe(true);
    expect(findingIsCurrent(f, { unitCost: 45 })).toBe(false);
  });

  it('holds while the field still has the value the review read', () => {
    const f = { field: 'capacity', currentValue: '16GB' };
    expect(findingIsCurrent(f, { capacity: '16 GB' })).toBe(true);
    expect(findingIsCurrent(f, { capacity: '32GB' })).toBe(false);
    expect(findingIsCurrent(f, undefined)).toBe(false);
  });
});
