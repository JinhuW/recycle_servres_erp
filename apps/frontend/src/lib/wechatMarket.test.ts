import { describe, expect, it } from 'vitest';
import { priceChange, priceSpread, type WechatPrice, type WechatRow } from '@recycle-erp/shared';
import {
  boardOrder, boardRows, FACETS, facetCounts, facetOrder, fmtPrice, ladder, matchesSearch, parseNotes, signalCounts,
  SIGNALS, UNBRANDED,
} from './wechatMarket';
import { matchWechatDay, pathToDesktopView, wechatDayPath } from './route';

const price = (median: number, over: Partial<WechatPrice> = {}): WechatPrice =>
  ({ bucket: 'RMB含税', n: 3, min: median - 500, median, max: median + 500, approx: 0, outliers: 0, ...over });

const side = (prices: WechatPrice[] = []) => ({ posts: 1, senders: 1, groups: 1, exposures: 1, qty: 0, prices });

function row(over: Partial<WechatRow>): WechatRow {
  return {
    kind: 'quote', key: 'k', brand: '三星', capacityGb: 64, speed: 5600, code: null, ddr: 'DDR5',
    formFactor: null, ranks: [], partNumbers: [], signal: null, buy: side(), sell: side(), prev: null,
    ...over,
  };
}

describe('WeChat market board', () => {
  it('sorts brands in trading order, unbranded last, bigger modules first', () => {
    const sorted = [
      row({ key: 'a', brand: UNBRANDED }),
      row({ key: 'b', brand: '海力士', capacityGb: 32 }),
      row({ key: 'c', brand: '三星', capacityGb: 32 }),
      row({ key: 'd', brand: '三星', capacityGb: 64, speed: 4800 }),
      row({ key: 'e', brand: '三星', capacityGb: 64, speed: 5600, code: 'DM0' }),
      row({ key: 'f', brand: '三星', capacityGb: 64, speed: 5600 }),
    ].sort(boardOrder);
    expect(sorted.map(r => r.key)).toEqual(['f', 'e', 'd', 'c', 'b', 'a']);
  });

  it('sorts a quote that says 未注明 with one that says nothing', () => {
    const sorted = [
      row({ key: 'a', brand: UNBRANDED, capacityGb: 32 }),
      row({ key: 'b', brand: null, capacityGb: 64 }),
      row({ key: 'c', brand: '三星' }),
      row({ key: 'd', brand: null, capacityGb: 16 }),
    ].sort(boardOrder);
    expect(sorted.map(r => r.key)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('searches the key, brand, ranks and part numbers', () => {
    const r = row({ key: '三星 64G 5600 DM0', partNumbers: ['M321R8GA0BB0-CQK'], ranks: ['2R4'] });
    expect(matchesSearch(r, 'm321r8')).toBe(true);
    expect(matchesSearch(r, '2r4')).toBe(true);
    expect(matchesSearch(r, ' ')).toBe(true);
    expect(matchesSearch(r, 'EB2')).toBe(false);
  });

  it('compares prices only within one tax basis', () => {
    expect(priceChange(price(16500), price(15000))).toBeCloseTo(0.1);
    expect(priceChange(price(16500), price(15000, { bucket: 'RMB未税' }))).toBeNull();
    expect(priceChange(price(16500), null)).toBeNull();
    const r = row({
      buy: side([price(14000, { bucket: 'RMB' }), price(15000)]),
      sell: side([price(16000), price(14500, { bucket: 'USD' })]),
    });
    expect(priceSpread(r)).toEqual({ value: 1000, bucket: 'RMB含税' });
  });

  it('lays both sides on one scale when they share a basis', () => {
    const both = ladder(row({ buy: side([price(15000)]), sell: side([price(16000)]) }))!;
    expect(both.bid).toEqual({ from: 0, to: 50, at: 25 });
    expect(both.ask).toEqual({ from: 50, to: 100, at: 75 });
    // Different bases: only the side with more quotes is drawn.
    const apart = ladder(row({
      buy: side([price(15000, { n: 5, bucket: 'RMB' })]),
      sell: side([price(16000, { n: 2 })]),
    }))!;
    expect([apart.bucket, apart.bid !== null, apart.ask]).toEqual(['RMB', true, null]);
    expect(ladder(row({}))).toBeNull();
  });

  it('formats yuan and dollars', () => {
    expect(fmtPrice(16650, 'RMB含税', 'en-US')).toBe('¥16,650');
    expect(fmtPrice(285, 'USD', 'en-US')).toBe('$285');
    expect(fmtPrice(12.5, 'USD', 'en-US')).toBe('$12.5');
  });

  it('reads Claude’s bullets and their bold runs', () => {
    expect(parseNotes('- **64G 5600** 需求最旺\n\n* 供给 **偏松**。')).toEqual([
      [{ bold: true, text: '64G 5600' }, { bold: false, text: ' 需求最旺' }],
      [{ bold: false, text: '供给 ' }, { bold: true, text: '偏松' }, { bold: false, text: '。' }],
    ]);
    expect(parseNotes(null)).toEqual([]);
  });

  it('routes /wechat and one day of it to the page', () => {
    expect(pathToDesktopView('/wechat')).toBe('wechat');
    expect(pathToDesktopView(wechatDayPath('2026-10-21'))).toBe('wechat');
    expect(matchWechatDay('/wechat/2026-10-21')).toEqual({ date: '2026-10-21' });
    expect(matchWechatDay('/wechat/latest')).toBeNull();
    expect(pathToDesktopView('/wechat/latest')).toBe('dashboard');
  });
});

describe('WeChat signal legend', () => {
  const rows = [
    row({ key: 'a', signal: '紧缺', buy: side([price(16000)]) }),
    row({ key: 'b', signal: '紧缺' }),
    row({ key: 'c', signal: '过剩', sell: side([price(15000)]) }),
    row({ key: 'd', signal: null, buy: side([price(9000)]) }),
    row({ key: 'e', signal: '看涨', buy: side([price(9000)]) }),
  ];

  it('lists the five signals from short to glut', () => {
    expect(SIGNALS).toEqual(['紧缺', '偏紧', '均衡', '偏松', '过剩']);
  });

  it('counts known signals only, every one present even at zero', () => {
    expect(signalCounts(rows)).toEqual({ 紧缺: 2, 偏紧: 0, 均衡: 0, 偏松: 0, 过剩: 1 });
  });

  it('filters the board by priced lines, search and signal together', () => {
    const keys = (f: Omit<Parameters<typeof boardRows>[1], 'picks'>) =>
      boardRows(rows, { ...f, picks: {} }).map(r => r.key);
    expect(keys({ pricedOnly: false, search: '', signal: null })).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(keys({ pricedOnly: true, search: '', signal: null })).toEqual(['a', 'c', 'd', 'e']);
    expect(keys({ pricedOnly: true, search: '', signal: '紧缺' })).toEqual(['a']);
    expect(keys({ pricedOnly: false, search: 'c', signal: null })).toEqual(['c']);
  });
});

describe('WeChat refine panel', () => {
  const rows = [
    row({ key: 'a', brand: '三星', ddr: 'DDR5', capacityGb: 64, ranks: ['2R4'] }),
    row({ key: 'b', brand: '海力士', ddr: 'DDR5', capacityGb: 32, ranks: ['1R4', '2R8'] }),
    row({ key: 'c', brand: '三星', ddr: 'DDR4', capacityGb: 32, speed: 3200, formFactor: 'pc', ranks: [] }),
    row({ key: 'd', brand: null, ddr: null, capacityGb: 16, speed: null, formFactor: 'server' }),
  ];
  const keys = (picks: Parameters<typeof boardRows>[1]['picks']) =>
    boardRows(rows, { pricedOnly: false, search: '', signal: null, picks }).map(r => r.key);

  it('matches any pick within a facet and every facet with picks', () => {
    expect(keys({ ddr: ['DDR4', 'DDR5'] })).toEqual(['a', 'b', 'c']);
    expect(keys({ ddr: ['DDR5'], capacity: ['32'] })).toEqual(['b']);
    expect(keys({ ddr: [] })).toEqual(['a', 'b', 'c', 'd']);
    // A line lists every rank it was quoted in.
    expect(keys({ rank: ['2R8'] })).toEqual(['b']);
    expect(keys({ brand: [UNBRANDED] })).toEqual(['d']);
  });

  it('counts each facet under the other facets’ picks, not its own', () => {
    const counts = facetCounts(rows, FACETS.quote, { brand: ['三星'], capacity: ['32'] });
    expect(counts.brand).toEqual({ 三星: 1, 海力士: 1 });
    expect(counts.capacity).toEqual({ 64: 1, 32: 1 });
    expect(counts.ddr).toEqual({ DDR4: 1 });
    expect(counts.form).toEqual({ pc: 1 });
    expect(counts.rank).toEqual({});
  });

  it('offers a brand only on the brand & code board', () => {
    expect(FACETS.quote).toContain('brand');
    expect(FACETS.spec).not.toContain('brand');
    expect(FACETS.code).not.toContain('brand');
  });

  it('orders chips numerically, brands as the board does', () => {
    expect(facetOrder('speed', ['6400', '2933', '10600'])).toEqual(['2933', '6400', '10600']);
    expect(facetOrder('capacity', ['128', '16', '64'])).toEqual(['16', '64', '128']);
    expect(facetOrder('brand', [UNBRANDED, '金士顿', '海力士', '三星'])).toEqual(['三星', '海力士', '金士顿', UNBRANDED]);
    expect(facetOrder('form', ['pc', 'server'])).toEqual(['server', 'pc']);
    expect(facetOrder('ddr', ['DDR5', 'DDR3', 'DDR4'])).toEqual(['DDR3', 'DDR4', 'DDR5']);
  });
});
