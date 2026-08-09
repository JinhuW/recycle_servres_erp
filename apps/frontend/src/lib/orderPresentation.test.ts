import { describe, it, expect } from 'vitest';
import { I18N } from './i18n';
import {
  createdEventParts, linePhotoEventDetail, profitTone, signedUSD0,
} from './orderPresentation';

// Stands in for useT: names the key it was asked for and the count it was
// given, which is what these assertions are actually about.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars && 'n' in vars ? `${key}(${vars.n})` : key;

describe('profitTone', () => {
  it('reads negative when the fees outrun the priced margin', () => {
    expect(profitTone(-195)).toBe('neg');
  });

  it('reads positive at zero and above', () => {
    expect(profitTone(0)).toBe('pos');
    expect(profitTone(1200)).toBe('pos');
  });
});

describe('signedUSD0', () => {
  it('puts a minus before the currency, not inside it', () => {
    expect(signedUSD0(-195)).toBe('−$195');
  });

  it('signs a gain', () => {
    expect(signedUSD0(1200)).toBe('+$1,200');
  });

  it('leaves zero unsigned', () => {
    expect(signedUSD0(0)).toBe('$0');
  });
});

describe('createdEventParts', () => {
  it('drops a category the draft never had', () => {
    expect(createdEventParts({ category: null, lineCount: 0, qty: 0 }, t)).toEqual([]);
  });

  it('lists category, lines and units when the order was created with them', () => {
    expect(createdEventParts({ category: 'RAM', lineCount: 3, qty: 12 }, t))
      .toEqual(['RAM', 'acNLines(3)', 'acNUnits(12)']);
  });

  it('uses the singular key for one line and one unit', () => {
    expect(createdEventParts({ category: 'SSD', lineCount: 1, qty: 1 }, t))
      .toEqual(['SSD', 'acNLine(1)', 'acNUnit(1)']);
  });

  it('shows the category alone on a backfilled row', () => {
    expect(createdEventParts({ backfilled: true, category: 'HDD', lineCount: 9, qty: 40 }, t))
      .toEqual(['HDD']);
  });
});

// tests/i18nCoverage.test.ts only scans for `t('literal')`, so a key picked by
// a ternary — every key on this path — is invisible to it. A missing one would
// print its own slug on the row, which is the bug these events already had.
describe('the keys the audit rows name', () => {
  it('are entries in both dictionaries', () => {
    const asked = new Set<string>(['acPhotoAdded', 'acPhotoRemoved']);
    const spy = (key: string) => { asked.add(key); return key; };
    createdEventParts({ category: 'RAM', lineCount: 1, qty: 1 }, spy);
    createdEventParts({ category: 'RAM', lineCount: 2, qty: 2 }, spy);
    const missing = [...asked].filter(k => !(k in I18N.en) || !(k in I18N.zh));
    expect(missing).toEqual([]);
  });
});

describe('linePhotoEventDetail', () => {
  it('names the file, its size and its type', () => {
    expect(linePhotoEventDetail({
      lineId: 'l1', photoId: 'p1', filename: 'label.jpg', size: 245760, mime: 'image/jpeg',
    })).toBe('label.jpg · 240.0 KB · image/jpeg');
  });

  it('carries only the filename a removal records', () => {
    expect(linePhotoEventDetail({ lineId: 'l1', photoId: 'p1', filename: 'label.jpg' }))
      .toBe('label.jpg');
  });
});
