import { describe, it, expect } from 'vitest';
import {
  checkListing, containsTerm, duplicateTerms, formatRule, formatTerm, foundTerms, keywordCount, markTerms, parseExpr, ruleMatches,
  ruleShape, shadowedTerms, splitEntry,
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

describe('keywordCount', () => {
  it('counts a keyword per chip, not per line', () => {
    expect(keywordCount(['single stick', EBAY, BRANDS, 'ram AND NOT laptop'])).toBe(1 + 6 + 16 + 1);
    expect(keywordCount([])).toBe(0);
  });
});

describe('shadowedTerms', () => {
  it('names the exclude keyword that catches every listing an include keyword would pass', () => {
    const s = shadowedTerms(['"ram stick" OR memory', 'Corsair', 'rams', 'ssd'], ['ram', BRANDS, 'sd card']);
    expect(s.get('ram stick')).toBe('ram');
    expect(s.get('rams')).toBe('ram');
    expect(s.get('corsair')).toBe('corsair');
    expect(s.has('memory')).toBe(false);
    // "sd card" needs "card" too, and "ssd" does not start with "sd".
    expect(s.has('ssd')).toBe(false);
  });

  it('leaves expressions out on both sides', () => {
    expect(shadowedTerms(['ram AND ecc'], ['ram']).size).toBe(0);
    expect(shadowedTerms(['ram'], ['ram AND NOT ecc']).size).toBe(0);
  });
});

describe('foundTerms', () => {
  it('finds every term the text holds, and each expression that matches', () => {
    const f = foundTerms(['single stick', BRANDS, 'ddr3 AND NOT ddr4'], 'Corsair Vengeance RGB single  stick DDR3');
    expect([...f.terms].sort()).toEqual(['corsair', 'rgb', 'single stick', 'vengeance']);
    expect([...f.exprs]).toEqual([2]);
  });
});

describe('markTerms', () => {
  const lists = { keywords: ['ram OR memory OR ddr4', SSD], antikeywords: [BRANDS] };
  const marked = (text: string) => markTerms(text, lists).map(r => (r.kind ? `[${r.kind}:${r.text}]` : r.text)).join('');

  it('marks include and exclude words where a word starts, as written', () => {
    expect(marked('Corsair Vengeance 32GB DDR4 RAM lot'))
      .toBe('[exc:Corsair] [exc:Vengeance] 32GB [inc:DDR4] [inc:RAM] lot');
    expect(marked('Ceramic tile, 4 SSDs')).toBe('Ceramic tile, 4 [inc:SSD]s');
  });

  it('finds a phrase across a run of spaces, and lets exclude win an overlap', () => {
    expect(marked('Solid   state drives')).toBe('[inc:Solid   state] drives');
    expect(markTerms('rgb ram', { keywords: ['rgb ram'], antikeywords: ['rgb'] }))
      .toEqual([{ text: 'rgb', kind: 'exc' }, { text: ' ram', kind: 'inc' }]);
    expect(markTerms('', lists)).toEqual([]);
  });
});
