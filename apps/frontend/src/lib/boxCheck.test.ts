import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import {
  asksToMoveToReviewing, boxCheckEventLines, checkBody, countOf, emptyCheck, isShortChecked, lineState, matchScan, nextOpenAfter, orderLines, readStageMoved, tally,
  type LineCheck,
} from './boxCheck';

const L = (id: string, qty: number, partNumber: string | null, serialNumber: string | null = null) =>
  ({ id, qty, partNumber, serialNumber });
const C = (lineId: string, counted: number, extra: Partial<LineCheck> = {}): LineCheck =>
  ({ lineId, counted, flagReason: null, flagNote: null, checkedAt: null, ...extra });
const AT = '2026-09-28T10:00:00Z';

const lines = [
  L('a', 16, 'M393A4K40DB3-CWE'),
  L('b', 8, 'MTC40F2046S1RC48BA1', 'SN-111\nSN-222'),
  L('c', 4, 'SSDSC2KB960G8'),
  L('d', 2, 'M393A4K40DB3-CWE'),
];

describe('the count starts full', () => {
  it('reads an untouched line as its whole qty, not yet checked', () => {
    expect(emptyCheck('a', 16)).toMatchObject({ counted: 16, checkedAt: null });
    expect(countOf(lines[0]!, undefined)).toBe(16);
    expect(lineState(lines[0]!, undefined)).toBe('open');
  });
});

describe('lineState', () => {
  it('is checked only when ticked, whatever the count', () => {
    expect(lineState(lines[0]!, C('a', 16))).toBe('open');
    expect(lineState(lines[0]!, C('a', 16, { checkedAt: AT }))).toBe('done');
  });

  it('turns a lowered, unticked line partial', () => {
    expect(lineState(lines[0]!, C('a', 14))).toBe('partial');
    expect(lineState(lines[0]!, C('a', 0))).toBe('partial');
  });

  it('ignores a flag left from before flags were retired', () => {
    expect(lineState(lines[0]!, C('a', 16, { checkedAt: AT, flagReason: 'damaged' }))).toBe('done');
    expect(lineState(lines[0]!, C('a', 16, { flagReason: 'damaged' }))).toBe('open');
  });

  it('checks a short line at its lowered count', () => {
    expect(lineState(lines[0]!, C('a', 14, { checkedAt: AT }))).toBe('done');
    expect(isShortChecked(lines[0]!, C('a', 14, { checkedAt: AT }))).toBe(true);
    expect(isShortChecked(lines[0]!, C('a', 16, { checkedAt: AT }))).toBe(false);
    expect(isShortChecked(lines[0]!, C('a', 14))).toBe(false);
  });

  it('keeps a tick when the line shrank under the count', () => {
    expect(lineState(L('x', 14, 'P'), C('x', 16, { checkedAt: AT }))).toBe('done');
  });
});

describe('orderLines', () => {
  it('keeps open lines in PO order, checked last and newest first', () => {
    const checks = new Map([
      ['a', C('a', 16, { checkedAt: '2026-09-28T10:00:00Z' })],
      ['b', C('b', 1)],
      ['c', C('c', 4, { checkedAt: '2026-09-28T11:00:00Z' })],
    ]);
    const o = orderLines(lines, checks);
    expect(o.open.map(l => l.id)).toEqual(['b', 'd']);
    expect(o.done.map(l => l.id)).toEqual(['c', 'a']);
  });
});

describe('tally', () => {
  it('counts only the units on checked lines', () => {
    const t = tally(lines, new Map([['c', C('c', 4, { checkedAt: AT })], ['a', C('a', 5)]]));
    expect(t.units).toBe(30);
    expect(t.counted).toBe(4);
    expect([t.done, t.partial, t.open]).toEqual([1, 1, 2]);
  });
});

describe('matchScan', () => {
  const hit = (r: ReturnType<typeof matchScan<typeof lines[number]>>) => (r && 'line' in r ? r.line.id : r);

  it('matches the part number ignoring separators and case', () => {
    expect(hit(matchScan(lines, new Map(), 'm393a4k40db3 cwe'))).toBe('a');
  });

  it('gives the scan to the first same-part line not yet checked', () => {
    expect(hit(matchScan(lines, new Map([['a', C('a', 16, { checkedAt: AT })]]), 'M393A4K40DB3-CWE'))).toBe('d');
  });

  it('passes over a short line while a same-part line is still open', () => {
    expect(hit(matchScan(lines, new Map([['a', C('a', 14)]]), 'M393A4K40DB3-CWE'))).toBe('d');
  });

  it('matches a label that carries a suffix the line does not', () => {
    expect(hit(matchScan(lines, new Map(), 'SSDSC2KB960G801'))).toBe('c');
  });

  it('refuses to guess between different part numbers a prefix fits', () => {
    const skus = [L('vk', 4, 'HMA84GR7AFR4N-VK'), L('uh', 4, 'HMA84GR7AFR4N-UH')];
    expect(matchScan(skus, new Map(), 'HMA84GR7AFR4N')).toEqual({ ambiguous: ['HMA84GR7AFR4N-VK', 'HMA84GR7AFR4N-UH'] });
    // A truncated scan is ambiguous whenever it fits more than one part number.
    expect(matchScan(skus, new Map(), 'hma84g')).toMatchObject({ ambiguous: expect.any(Array) });
  });

  it('gives a suffixed label to the most specific line it extends', () => {
    const two = [L('base', 2, 'M393A4K40DB3'), L('cwe', 2, 'M393A4K40DB3-CWE')];
    expect(hit(matchScan(two, new Map(), 'M393A4K40DB3-CWE-BY'))).toBe('cwe');
  });

  it('falls back to a recorded serial, and misses cleanly', () => {
    expect(hit(matchScan(lines, new Map(), 'sn-222'))).toBe('b');
    expect(matchScan(lines, new Map(), 'NOPE-123')).toBeNull();
  });
});

describe('nextOpenAfter', () => {
  it('moves to the next unchecked line below, wrapping to the top', () => {
    const checks = new Map([['b', C('b', 8, { checkedAt: AT })]]);
    expect(nextOpenAfter(lines, checks, 'a')?.id).toBe('c');
    expect(nextOpenAfter(lines, checks, 'd')?.id).toBe('a');
  });
});

describe('checkBody', () => {
  it('says whether the line is checked, so no write can re-derive it from the count', () => {
    expect(checkBody(C('a', 16), 16)).toEqual({ counted: 16, checked: false, flagReason: null, flagNote: null });
    // Clears a flag stored before flags were retired.
    expect(checkBody(C('a', 16, { flagReason: 'damaged', flagNote: 'x' }), 16)).toMatchObject({ flagReason: null, flagNote: null });
    expect(checkBody(C('a', 14, { checkedAt: AT }), 16)).toMatchObject({ checked: true });
  });

  it('clamps a count the line has since shrunk below', () => {
    expect(checkBody(C('a', 16, { checkedAt: AT }), 14)).toMatchObject({ counted: 14, checked: true });
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

describe('asksToMoveToReviewing', () => {
  it('asks only before Reviewing', () => {
    expect(asksToMoveToReviewing({ lifecycle: 'draft', archived: false })).toBe(true);
    expect(asksToMoveToReviewing({ lifecycle: 'in_transit', archived: false })).toBe(true);
    for (const lifecycle of ['reviewing', 'ready_to_pay', 'done', 'sold']) {
      expect(asksToMoveToReviewing({ lifecycle, archived: false })).toBe(false);
    }
  });

  it('never asks of an archived PO', () => {
    expect(asksToMoveToReviewing({ lifecycle: 'in_transit', archived: true })).toBe(false);
  });
});

describe('readStageMoved', () => {
  it('reads where the PO really is off the stageMoved refusal', () => {
    const err = new ApiError(409, 'Order is now Draft', {}, { error: 'x', code: 'stageMoved', lifecycle: 'draft' });
    expect(readStageMoved(err)).toBe('draft');
  });

  it('leaves every other failure alone', () => {
    expect(readStageMoved(new ApiError(409, 'Say where this order came from', {}, { error: 'x' }))).toBeNull();
    expect(readStageMoved(new ApiError(409, 'x', {}, { code: 'stageMoved' }))).toBeNull();
    expect(readStageMoved(new ApiError(400, 'x', {}, { code: 'stageMoved', lifecycle: 'draft' }))).toBeNull();
    expect(readStageMoved(new Error('network'))).toBeNull();
  });
});
