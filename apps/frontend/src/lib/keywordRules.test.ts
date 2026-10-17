import { describe, it, expect } from 'vitest';
import {
  addToGroup, checkListing, containsTerm, duplicateTerms, formatRule, formatTerm, parseExpr, ruleMatches, ruleShape, splitEntry,
} from './keywordRules';

// Live rules from the fleet's server_ram item.
const BRANDS = 'corsair OR vengeance OR dominator OR g.skill OR gskill OR trident OR ripjaws OR aegis OR t-force OR tforce OR teamgroup OR xpg OR ballistix OR hyperx OR fury OR rgb';
const EBAY = '"ebay store" OR "my ebay" OR "ebay listing" OR "ebay.com" OR "our ebay" OR "ebay feedback"';
const SSD = 'ssd OR nvme OR u.2 OR sas OR m.2 OR "solid state"';

describe('containsTerm', () => {
  it.each([
    ['ram', 'Server RAM lot', true],
    ['ram', 'ceramic mug', false],
    ['ssd', '4x ssds', true],
    ['+ecc', 'ddr4 +ecc lot', true],
    ['hard drive', 'two hard   drives', true],
    ['ebay.com', 'see ebay.com/itm', true],
  ])('%s in %s → %s', (term, text, want) => {
    expect(containsTerm(term, text)).toBe(want);
  });
});

describe('ruleMatches', () => {
  it.each([
    ['ram AND NOT laptop', '32GB ram', true],
    ['ram AND NOT laptop', 'laptop ram', false],
    ['(ddr4 OR ddr5) AND ecc', 'DDR5 ECC RDIMM', true],
    ['(ddr4 OR ddr5) AND ecc', 'DDR5 desktop', false],
    ['NOT a OR b', 'b a', true],
    ['"solid state"', 'solid state drive', true],
    // Unparseable, so a literal: the two words together, not either one.
    ['hard drive', 'hard to drive', false],
    ['single stick', 'one single stick', true],
    [EBAY, 'Check my eBay store', true],
  ])('%s on %s → %s', (rule, text, want) => {
    expect(ruleMatches(rule, text)).toBe(want);
  });

  it('falls back to a literal when it does not parse', () => {
    expect(parseExpr('ram AND')).toBeNull();
    expect(parseExpr('café')).toBeNull();
    expect(ruleMatches('ram AND', 'ram and more')).toBe(true);
  });
});

describe('ruleShape / formatRule', () => {
  it('reads a plain OR as its terms', () => {
    expect(ruleShape(SSD)).toMatchObject({ kind: 'terms', terms: ['ssd', 'nvme', 'u.2', 'sas', 'm.2', 'solid state'] });
    expect(ruleShape('hard drive')).toEqual({ kind: 'terms', terms: ['hard drive'], raw: ['hard drive'] });
    expect(ruleShape('ram AND NOT laptop')).toEqual({ kind: 'expr' });
    expect(ruleShape('(a OR b)')).toEqual({ kind: 'expr' });
  });

  it.each([BRANDS, EBAY, SSD, 'single stick', 'hdd'])('writes %s back unchanged', rule => {
    const shape = ruleShape(rule);
    expect(shape.kind).toBe('terms');
    if (shape.kind === 'terms') expect(formatRule(shape.raw)).toBe(rule);
  });

  it('quotes what would otherwise read as operators', () => {
    expect(formatRule(['NOT working'])).toBe('"NOT working"');
    expect(formatRule(['ram', 'solid state', 'AND'].map(formatTerm))).toBe('ram OR "solid state" OR "AND"');
    expect(formatRule(['"solid state"'])).toBe('"solid state"');
  });
});

describe('splitEntry', () => {
  it('splits plain text on lines and commas, keeps an expression whole', () => {
    expect(splitEntry('hdd, usb\nlaptop')).toEqual(['hdd', 'usb', 'laptop']);
    expect(splitEntry('ram AND NOT laptop')).toEqual(['ram AND NOT laptop']);
    expect(splitEntry('"a, b" OR c')).toEqual(['"a, b" OR c']);
  });
});

describe('duplicateTerms', () => {
  it('finds a term repeated across a list, ignoring case', () => {
    expect([...duplicateTerms(['rgb', BRANDS, 'Gaming', 'gaming'])].sort()).toEqual(['gaming', 'rgb']);
  });
});

describe('checkListing', () => {
  const ram = { keywords: ['ram OR memory OR dimm OR ddr4 OR ecc'], antikeywords: ['single stick', EBAY, BRANDS] };
  const full = { titleOnly: false, prefilter: true };

  it('drops on an anti-keyword and names the term', () => {
    expect(checkListing(ram, 'Corsair Vengeance 32GB DDR4', '', full))
      .toEqual({ kind: 'anti', hit: { rule: 2, term: 'corsair' } });
  });

  it('passes on a keyword in the description', () => {
    expect(checkListing(ram, 'Server pull lot', '64GB ECC sticks', full))
      .toEqual({ kind: 'pass', hit: { rule: 0, term: 'ecc' } });
    expect(checkListing(ram, 'Server pull lot', 'Xeon CPUs', full)).toEqual({ kind: 'missing' });
  });

  it('on the title alone, rejects only with the prefilter on and a title long enough', () => {
    const t = (title: string, prefilter: boolean) => checkListing(ram, title, 'ddr4', { titleOnly: true, prefilter });
    expect(t('Harmonica set with case', true)).toEqual({ kind: 'missing' });
    expect(t('Harmonica set with case', false)).toEqual({ kind: 'deferred', reason: 'prefilter' });
    expect(t('Server lot', true)).toEqual({ kind: 'deferred', reason: 'short' });
  });
});

describe('addToGroup', () => {
  it('keeps operands already quoted instead of quoting them again', () => {
    expect(addToGroup('ssd OR nvme', '"solid state"')).toBe('ssd OR nvme OR "solid state"');
    expect(addToGroup('ssd OR nvme', '"m.2"')).toBe('ssd OR nvme OR "m.2"');
    expect(ruleMatches(addToGroup('ssd OR nvme', '"solid state"')!, 'solid state drive')).toBe(true);
  });

  it('quotes a bare phrase, and leaves an expression alone', () => {
    expect(addToGroup('ssd OR nvme', 'hard drive')).toBe('ssd OR nvme OR "hard drive"');
    expect(addToGroup('ssd', 'sata, sas')).toBe('ssd OR sata OR sas');
    expect(addToGroup('ssd AND NOT used', 'nvme')).toBeNull();
  });
});
