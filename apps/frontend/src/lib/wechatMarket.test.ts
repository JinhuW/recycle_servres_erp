import { describe, expect, it } from 'vitest';
import { priceChange, priceSpread, type WechatPrice, type WechatRow } from '@recycle-erp/shared';
import { fmtPrice, groupByBrand, ladder, matchesSearch, parseNotes, UNBRANDED } from './wechatMarket';
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
  it('groups brands in trading order, unbranded last, bigger modules first', () => {
    const groups = groupByBrand([
      row({ key: 'a', brand: UNBRANDED }),
      row({ key: 'b', brand: '海力士', capacityGb: 32 }),
      row({ key: 'c', brand: '三星', capacityGb: 32 }),
      row({ key: 'd', brand: '三星', capacityGb: 64, speed: 4800 }),
      row({ key: 'e', brand: '三星', capacityGb: 64, speed: 5600, code: 'DM0' }),
      row({ key: 'f', brand: '三星', capacityGb: 64, speed: 5600 }),
    ]);
    expect(groups.map(g => [g.brand, g.rows.map(r => r.key)])).toEqual([
      ['三星', ['f', 'e', 'd', 'c']],
      ['海力士', ['b']],
      [UNBRANDED, ['a']],
    ]);
  });

  it('keeps one unbranded group whether a quote says 未注明 or nothing', () => {
    const groups = groupByBrand([
      row({ key: 'a', brand: UNBRANDED, capacityGb: 32 }),
      row({ key: 'b', brand: null, capacityGb: 64 }),
      row({ key: 'c', brand: '三星' }),
      row({ key: 'd', brand: null, capacityGb: 16 }),
    ]);
    expect(groups.map(g => [g.brand, g.rows.map(r => r.key)])).toEqual([
      ['三星', ['c']],
      [UNBRANDED, ['b', 'a', 'd']],
    ]);
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
