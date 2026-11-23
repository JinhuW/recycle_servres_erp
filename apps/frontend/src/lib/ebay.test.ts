import { describe, it, expect } from 'vitest';
import {
  firstTabWithWork, partInputs, partTotals, shelfBar, shortItemId, splitLineHolders, stockShortfall, tabForStatus,
  type PartRow,
} from './ebay';

const counts = (c: Partial<Record<'Queued' | 'Listed' | 'Sold' | 'Ended' | 'ToConfirm', number>>) =>
  ({ Queued: 0, Listed: 0, Sold: 0, Ended: 0, ToConfirm: 0, ...c });

describe('firstTabWithWork', () => {
  it('opens on To post, then Sales to confirm, then Live', () => {
    expect(firstTabWithWork(counts({ Queued: 2, ToConfirm: 1, Listed: 5 }))).toBe('post');
    expect(firstTabWithWork(counts({ ToConfirm: 1, Listed: 5 }))).toBe('confirm');
    expect(firstTabWithWork(counts({ Listed: 5, Sold: 3 }))).toBe('live');
    expect(firstTabWithWork(counts({}))).toBe('live');
  });

  it('maps each status to the tab that lists it', () => {
    expect(tabForStatus('Queued')).toBe('post');
    expect(tabForStatus('Listed')).toBe('live');
    expect(tabForStatus('Sold')).toBe('sold');
    expect(tabForStatus('Ended')).toBe('ended');
  });
});

describe('shelfBar', () => {
  it('fills over 30 days', () => {
    expect(shelfBar(0)).toEqual({ pct: 0, over: false });
    expect(shelfBar(15)).toEqual({ pct: 50, over: false });
    expect(shelfBar(21)).toEqual({ pct: 70, over: false });
    expect(shelfBar(30)).toEqual({ pct: 100, over: false });
  });

  it('stays full and turns warn after 30 days', () => {
    expect(shelfBar(31)).toEqual({ pct: 100, over: true });
    expect(shelfBar(44)).toEqual({ pct: 100, over: true });
  });

  it('reads a negative day count as none', () => {
    expect(shelfBar(-2)).toEqual({ pct: 0, over: false });
  });
});

const row = (key: number, qty: string, price = '10', spec = ''): PartRow => ({ key, qty, price, spec });

describe('partTotals', () => {
  it('lets a send leave units sellable, and blocks one over the limit', () => {
    expect(partTotals([row(1, '12'), row(2, '8')], 20, false)).toMatchObject({ assigned: 20, over: false, short: false, ok: true });
    expect(partTotals([row(1, '12'), row(2, '3')], 20, false)).toMatchObject({ assigned: 15, ok: true });
    expect(partTotals([row(1, '12'), row(2, '9')], 20, false)).toMatchObject({ assigned: 21, over: true, ok: false });
  });

  it('makes a split hand out exactly what the listing holds, in two parts or more', () => {
    expect(partTotals([row(1, '6'), row(2, '4')], 10, true, 2).ok).toBe(true);
    expect(partTotals([row(1, '6'), row(2, '3')], 10, true, 2)).toMatchObject({ short: true, ok: false });
    expect(partTotals([row(1, '10')], 10, true, 2).ok).toBe(false);
  });

  it('names the rows whose units or price will not go', () => {
    const t = partTotals([row(1, '0'), row(2, '2.5'), row(3, '2', ''), row(4, '2', '-1'), row(5, '2', '4.50')], 99, false);
    expect(t.badRows).toEqual([1, 2, 3, 4]);
    expect(t.assigned).toBe(6);
    expect(t.ok).toBe(false);
  });

  it('needs at least one row to send', () => {
    expect(partTotals([], 5, false).ok).toBe(false);
  });
});

describe('partInputs', () => {
  it('posts numbers, cents rounded, and a blank spec as none', () => {
    expect(partInputs([row(1, '3', '17.499', ' 16GB DDR4 '), row(2, '1', '5', '  ')])).toEqual([
      { qty: 3, listPrice: 17.5, spec: '16GB DDR4' },
      { qty: 1, listPrice: 5, spec: null },
    ]);
  });
});

describe('stockShortfall', () => {
  it('is zero while the counts add up, and the excess when more is promised than held', () => {
    expect(stockShortfall({ onHand: 20, heldForEbay: 20, heldForSellOrders: 0, sellable: 0 })).toBe(0);
    expect(stockShortfall({ onHand: 6, heldForEbay: 4, heldForSellOrders: 1, sellable: 1 })).toBe(0);
    expect(stockShortfall({ onHand: 0, heldForEbay: 3, heldForSellOrders: 0, sellable: -3 })).toBe(3);
  });
});

describe('shortItemId', () => {
  it('keeps the ends of a long eBay item number', () => {
    expect(shortItemId('256712340987')).toBe('2567…0987');
    expect(shortItemId('1234567')).toBe('1234567');
  });
});

describe('splitLineHolders', () => {
  it('tells eBay listings from sell orders', () => {
    expect(splitLineHolders(['SO-4080', 'EB-12', 'SO-4081'])).toEqual({ sellOrders: ['SO-4080', 'SO-4081'], ebay: ['EB-12'] });
    expect(splitLineHolders([])).toEqual({ sellOrders: [], ebay: [] });
  });
});
