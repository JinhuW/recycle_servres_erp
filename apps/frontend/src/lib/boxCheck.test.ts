import { describe, it, expect } from 'vitest';
import { boxCheckEventLines, lineState, matchScan, nextOpenAfter, orderLines, tally, type LineCheck } from './boxCheck';

const L = (id: string, qty: number, partNumber: string | null, serialNumber: string | null = null) =>
  ({ id, qty, partNumber, serialNumber });
const C = (lineId: string, counted: number, extra: Partial<LineCheck> = {}): LineCheck =>
  ({ lineId, counted, flagReason: null, flagNote: null, checkedAt: null, ...extra });

const lines = [
  L('a', 16, 'M393A4K40DB3-CWE'),
  L('b', 8, 'MTC40F2046S1RC48BA1', 'SN-111\nSN-222'),
  L('c', 4, 'SSDSC2KB960G8'),
  L('d', 2, 'M393A4K40DB3-CWE'),
];

describe('lineState', () => {
  it('reads open, partial and done from the count', () => {
    expect(lineState(lines[0]!, undefined)).toBe('open');
    expect(lineState(lines[0]!, C('a', 3))).toBe('partial');
    expect(lineState(lines[0]!, C('a', 16))).toBe('done');
  });

  it('keeps a flagged line out of done even when fully counted', () => {
    expect(lineState(lines[0]!, C('a', 16, { flagReason: 'damaged' }))).toBe('flagged');
  });
});

describe('orderLines', () => {
  it('keeps open lines in PO order, flagged next, checked last and newest first', () => {
    const checks = new Map([
      ['a', C('a', 16, { checkedAt: '2026-09-28T10:00:00Z' })],
      ['b', C('b', 1, { flagReason: 'short' })],
      ['c', C('c', 4, { checkedAt: '2026-09-28T11:00:00Z' })],
    ]);
    const o = orderLines(lines, checks);
    expect(o.open.map(l => l.id)).toEqual(['d']);
    expect(o.flagged.map(l => l.id)).toEqual(['b']);
    expect(o.done.map(l => l.id)).toEqual(['c', 'a']);
  });
});

describe('tally', () => {
  it('counts units without overshooting a line whose qty went down', () => {
    const t = tally(lines, new Map([['c', C('c', 9)], ['a', C('a', 5)]]));
    expect(t.units).toBe(30);
    expect(t.counted).toBe(9);
    expect([t.done, t.partial, t.open, t.flagged]).toEqual([1, 1, 2, 0]);
  });
});

describe('matchScan', () => {
  it('matches the part number ignoring separators and case', () => {
    expect(matchScan(lines, new Map(), 'm393a4k40db3 cwe')?.id).toBe('a');
  });

  it('gives the unit to the first same-part line still short', () => {
    expect(matchScan(lines, new Map([['a', C('a', 16)]]), 'M393A4K40DB3-CWE')?.id).toBe('d');
  });

  it('matches a label that carries a suffix the line does not', () => {
    expect(matchScan(lines, new Map(), 'SSDSC2KB960G801')?.id).toBe('c');
  });

  it('falls back to a recorded serial, and misses cleanly', () => {
    expect(matchScan(lines, new Map(), 'sn-222')?.id).toBe('b');
    expect(matchScan(lines, new Map(), 'NOPE-123')).toBeNull();
  });
});

describe('nextOpenAfter', () => {
  it('moves to the next open line below, wrapping to the top', () => {
    const checks = new Map([['b', C('b', 8)]]);
    expect(nextOpenAfter(lines, checks, 'a')?.id).toBe('c');
    expect(nextOpenAfter(lines, checks, 'd')?.id).toBe('a');
  });
});

describe('boxCheckEventLines', () => {
  it('lists flags then extras', () => {
    const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}:${JSON.stringify(v)}` : k);
    const r = boxCheckEventLines({
      flags: [{ partNumber: 'P1', reason: 'damaged', note: 'bent pins' }],
      extras: [{ partNumber: 'X9', note: null }],
    }, t);
    expect(r.count).toBe(2);
    expect(r.lines).toEqual(['P1: bcReasonDamaged (bent pins)', 'bcExtraItem:{"pn":"X9"}']);
  });
});
