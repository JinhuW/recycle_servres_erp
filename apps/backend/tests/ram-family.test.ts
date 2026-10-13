import { describe, it, expect } from 'vitest';
import { ddr5SpecKey, ramFamily, ramFamilyLabel, type Ddr5SpecRow } from '@recycle-erp/shared';

const key = (pn: string) => ramFamily(pn)?.key ?? null;

describe('ramFamily', () => {
  it('merges suffix variants of one module', () => {
    const same: string[][] = [
      ['M393A2K43BB1-CTD', 'M393A2K43BB1-CTD7Q', 'M393A2K43BB1-CTDQ', 'm393a2k43bb1 ctd7q'],
      ['M393A2G40EB1-CPB0Q', 'M393A2G40EB1-CPBQ'],
      ['M425R1GB4BB0-CQK0L', 'M425R1GB4BB0-CQKOL'],
      ['M386A8K40BM2-CTD6', 'M386A8K40BM2-CTD6Y'],
      ['HMA82GR7CJR8N-VK', 'HMA82GR7CJR8N-VKTF', 'HMA82GR7CJR8NVK'],
      ['MTA36ASF2G72PZ-2G1A2II', 'MTA36ASF2G72PZ-2G1A2KJ'],
      ['MT36KSF2G72PZ-1G6E1HG', 'MT36KSF2G72PZ-1G6E1HI'],
      ['MTA18ASF2G72AZ-2G3B1ZI', 'MTA18ASF2G72AZ-2G3B1ZK'],
    ];
    for (const group of same) {
      const k = key(group[0]);
      expect(k, group[0]).not.toBeNull();
      for (const pn of group) expect(key(pn), pn).toBe(k);
    }
  });

  it('keys a dashed packaging tail the same as its dash-free spelling', () => {
    expect(ramFamily('HMA82GR7CJR8N-VK-TF')?.key).toBe(ramFamily('HMA82GR7CJR8N-VKTF')?.key);
    expect(ramFamily('HMA82GR7CJR8N-VK-TF')?.key).toBe(ramFamily('HMA82GR7CJR8N-VK')?.key);
  });

  it('keeps module form, die, organisation and speed apart', () => {
    const apart: [string, string][] = [
      ['M393A2K43BB1-CTD', 'M391A2K43BB1-CTD'], // RDIMM vs ECC UDIMM
      ['M378A2K43DB1-CTD', 'M471A2K43DB1-CTD'], // UDIMM vs SODIMM
      ['M393A2G40EB1-CRC0', 'M393A2G40EB1-CPB0Q'], // speed
      ['M393A2G40EB1-CPBQ', 'M393A2G40DB0-CPB30'], // die
      ['M393A2K43BB1-CTD', 'M393A2K40BB1-CTD'], // organisation
      ['HMA82GR7CJR8N-VK', 'HMA82GU7CJR8N-VK'], // RDIMM vs ECC UDIMM
      ['HMA82GR7CJR8N-VK', 'HMA82GR7CJR8N-WM'], // speed
      ['MTA18ASF2G72PZ-2G3B1', 'MTA18ASF2G72PDZ-2G3B1'], // 1Rx4 vs 2Rx8
      ['MTA18ASF2G72PDZ-2G3B1', 'MTA18ASF2G72AZ-2G3B1'], // RDIMM vs ECC UDIMM
      ['MTA36ASF4G72PZ-2G6J1QI', 'MTA36ASF4G72PZ-2G6D1QK'], // die
    ];
    for (const [a, b] of apart) {
      expect(key(a), a).not.toBeNull();
      expect(key(b), b).not.toBeNull();
      expect(key(a), `${a} vs ${b}`).not.toBe(key(b));
    }
  });

  it('gives no family to a part number no scheme reads', () => {
    for (const pn of ['CMK16GX4M2B3000C15', '752369-081', 'HMCG88AGBSA092N', 'KSM26RD8/16HDI', '9995702-057.A00G', '', null]) {
      expect(ramFamily(pn), String(pn)).toBeNull();
    }
  });

  it('labels the family as written, cut at its end', () => {
    const lbl = (pn: string) => ramFamilyLabel(pn, ramFamily(pn)!);
    expect(lbl('M393A2K43BB1-CTD7Q')).toBe('M393A2K43BB1-CTD*');
    expect(lbl('HMA82GR7CJR8N-VKTF')).toBe('HMA82GR7CJR8N-VK*');
    expect(lbl('MTA36ASF2G72PZ-2G1A2II')).toBe('MTA36ASF2G72PZ-2G1A2*');
  });
});

describe('ddr5SpecKey', () => {
  const row = (over: Partial<Ddr5SpecRow> = {}): Ddr5SpecRow => ({
    category: 'RAM', generation: 'DDR5', brand: 'Samsung', type: 'Server',
    capacity: '32GB', rank: '2Rx4', speed: '4800', classification: 'RDIMM', ...over,
  });

  it('keys a DDR5 line on brand, type, capacity, rank, speed and form, however they were typed', () => {
    const k = ddr5SpecKey(row());
    expect(k).toMatch(/^ddr5:/);
    expect(ddr5SpecKey(row({ brand: ' samsung ', speed: ' 4800', generation: 'ddr5' }))).toBe(k);
  });

  it('separates lines that differ on any key field, and keys blank on blank', () => {
    const k = ddr5SpecKey(row());
    for (const f of ['brand', 'type', 'capacity', 'rank', 'speed', 'classification'] as const) {
      expect(ddr5SpecKey(row({ [f]: 'X' })), f).not.toBe(k);
      expect(ddr5SpecKey(row({ [f]: null })), f).not.toBe(k);
      expect(ddr5SpecKey(row({ [f]: null })), f).toBe(ddr5SpecKey(row({ [f]: '' })));
    }
  });

  it('gives no key to other generations or categories', () => {
    expect(ddr5SpecKey(row({ generation: 'DDR4' }))).toBeNull();
    expect(ddr5SpecKey(row({ generation: null }))).toBeNull();
    expect(ddr5SpecKey(row({ category: 'SSD' }))).toBeNull();
  });
});
