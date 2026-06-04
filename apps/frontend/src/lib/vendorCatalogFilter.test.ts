import { describe, it, expect } from 'vitest';
import type { CatalogItem } from './vendor';
import {
  attrSpecsFor, sortAttrValues, matchesSearch, filterCatalogItems, computeFacets,
} from './vendorCatalogFilter';

function item(partial: Partial<CatalogItem>): CatalogItem {
  return { id: 'x', category: 'RAM', qty: 1, ...partial };
}

describe('attrSpecsFor', () => {
  it('returns the schema for known categories', () => {
    expect(attrSpecsFor('RAM').map(s => s.key)).toContain('generation');
    expect(attrSpecsFor('SSD').map(s => s.key)).toEqual(
      ['brand', 'capacity', 'interface', 'form_factor']);
    expect(attrSpecsFor('HDD').map(s => s.key)).toContain('rpm');
  });

  it('returns [] for categories without attribute facets', () => {
    expect(attrSpecsFor('all')).toEqual([]);
    expect(attrSpecsFor('Other')).toEqual([]);
  });
});

describe('sortAttrValues', () => {
  it('sorts numeric attrs numerically', () => {
    expect(sortAttrValues('speed', ['3200', '2400', '12800']))
      .toEqual(['2400', '3200', '12800']);
  });

  it('sorts other attrs naturally (numeric-aware)', () => {
    expect(sortAttrValues('capacity', ['16GB', '4GB', '8GB']))
      .toEqual(['4GB', '8GB', '16GB']);
  });
});

describe('matchesSearch', () => {
  const it1 = item({ brand: 'Samsung', capacity: '16GB', type: 'UDIMM', part_number: 'M378A2K43' });

  it('matches empty/whitespace query', () => {
    expect(matchesSearch(it1, '')).toBe(true);
    expect(matchesSearch(it1, '   ')).toBe(true);
  });

  it('matches across label, part number and attributes, case-insensitively', () => {
    expect(matchesSearch(it1, 'samsung')).toBe(true);
    expect(matchesSearch(it1, '16gb')).toBe(true);
    expect(matchesSearch(it1, 'm378')).toBe(true);
  });

  it('requires every whitespace-separated token to match', () => {
    expect(matchesSearch(it1, 'samsung 16gb')).toBe(true);
    expect(matchesSearch(it1, 'samsung 32gb')).toBe(false);
  });

  it('returns false when nothing matches', () => {
    expect(matchesSearch(it1, 'kingston')).toBe(false);
  });
});

describe('filterCatalogItems', () => {
  const items = [
    item({ id: 'a', brand: 'Samsung', capacity: '16GB', generation: 'DDR4' }),
    item({ id: 'b', brand: 'Hynix', capacity: '8GB', generation: 'DDR4' }),
    item({ id: 'c', brand: 'Samsung', capacity: '8GB', generation: 'DDR5' }),
  ];

  it('filters by search only', () => {
    expect(filterCatalogItems(items, 'hynix', {}).map(i => i.id)).toEqual(['b']);
  });

  it('filters by a single attribute (OR within a key)', () => {
    expect(filterCatalogItems(items, '', { capacity: ['8GB'] }).map(i => i.id))
      .toEqual(['b', 'c']);
  });

  it('filters by multiple attributes (AND across keys)', () => {
    expect(filterCatalogItems(items, '', { brand: ['Samsung'], capacity: ['8GB'] })
      .map(i => i.id)).toEqual(['c']);
  });

  it('combines search and attribute filters', () => {
    expect(filterCatalogItems(items, 'ddr4', { brand: ['Samsung'] }).map(i => i.id))
      .toEqual(['a']);
  });

  it('excludes items missing a filtered attribute', () => {
    const withNull = [...items, item({ id: 'd', brand: null, capacity: '8GB' })];
    expect(filterCatalogItems(withNull, '', { brand: ['Samsung'] }).map(i => i.id))
      .toEqual(['a', 'c']);
  });
});

describe('computeFacets', () => {
  const items = [
    item({ brand: 'Samsung', capacity: '16GB' }),
    item({ brand: 'Samsung', capacity: '8GB' }),
    item({ brand: 'Hynix', capacity: '8GB' }),
  ];
  const specs = attrSpecsFor('RAM');

  it('counts values per attribute key', () => {
    const f = computeFacets(items, specs, '', {});
    expect(f.brand).toEqual({ Samsung: 2, Hynix: 1 });
    expect(f.capacity).toEqual({ '16GB': 1, '8GB': 2 });
  });

  it('respects search when counting', () => {
    const f = computeFacets(items, specs, 'hynix', {});
    expect(f.brand).toEqual({ Hynix: 1 });
    expect(f.capacity).toEqual({ '8GB': 1 });
  });

  it('counts a key against OTHER active filters but not itself', () => {
    const f = computeFacets(items, specs, '', { brand: ['Samsung'] });
    // capacity counts narrow to Samsung rows...
    expect(f.capacity).toEqual({ '16GB': 1, '8GB': 1 });
    // ...but brand still shows every brand so the selection stays changeable.
    expect(f.brand).toEqual({ Samsung: 2, Hynix: 1 });
  });
});
