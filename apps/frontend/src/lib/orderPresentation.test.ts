import { describe, it, expect } from 'vitest';
import { I18N } from './i18n';
import zh from './i18n.zh';
import {
  createdEventParts, inTransitDetail, linePhotoEventDetail, ownerChangedLine, profitTone,
  signedUSD0, trackingNote,
} from './orderPresentation';
import type { PackageTracking } from './types';

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

  it('names the purchaser when a manager filed the order for them', () => {
    const tt = (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}(${Object.values(vars).join(',')})` : key;
    expect(createdEventParts(
      { category: 'RAM', lineCount: 1, qty: 2, onBehalfOfName: 'Marcus Wright' }, tt,
    )).toEqual(['RAM', 'acNLine(1)', 'acNUnits(2)', 'acCreatedFor(Marcus Wright)']);
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
    createdEventParts({ category: 'RAM', lineCount: 1, qty: 1, onBehalfOfName: 'X' }, spy);
    const missing = [...asked].filter(k => !(k in I18N.en!) || !(k in zh));
    expect(missing).toEqual([]);
  });
});

describe('ownerChangedLine', () => {
  it('reads old owner → new owner from the snapshotted names', () => {
    expect(ownerChangedLine({ from: 'Alex Chen', to: 'Marcus Wright' }))
      .toBe('Alex Chen → Marcus Wright');
  });

  it('shows a dash for a name the event never captured', () => {
    expect(ownerChangedLine({ to: 'Marcus Wright' })).toBe('— → Marcus Wright');
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

describe('inTransitDetail', () => {
  const ups: PackageTracking = {
    carrier: 'UPS', trackingNumber: '1Z999AA10123456784',
    trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  };

  it('names the carrier and links its tracking page', () => {
    expect(inTransitDetail({ lifecycle: 'in_transit', handoffMethod: 'label', tracking: ups }, t))
      .toEqual({ text: 'UPS', href: ups.trackingUrl });
  });

  it('says Local for a pickup, with nowhere to go', () => {
    expect(inTransitDetail({ lifecycle: 'in_transit', handoffMethod: 'pickup', tracking: null }, t))
      .toEqual({ text: 'inboundLocal', href: null });
  });

  it('prefers a box on file over the recorded method', () => {
    expect(inTransitDetail({ lifecycle: 'in_transit', handoffMethod: 'pickup', tracking: ups }, t)?.text)
      .toBe('UPS');
  });

  it('adds nothing to a PO that left Draft before the hand-off existed', () => {
    expect(inTransitDetail({ lifecycle: 'in_transit' }, t)).toBeNull();
    expect(inTransitDetail({ lifecycle: 'in_transit', handoffMethod: null, tracking: null }, t)).toBeNull();
  });

  it('adds nothing on any other stage', () => {
    expect(inTransitDetail({ lifecycle: 'reviewing', handoffMethod: 'label', tracking: ups }, t)).toBeNull();
    expect(inTransitDetail({ lifecycle: 'draft', handoffMethod: 'pickup', tracking: null }, t)).toBeNull();
  });
});

describe('trackingNote', () => {
  // Names the key and the ETA it was handed, which is what these are about.
  const tt = (key: string, vars?: Record<string, string | number>) =>
    vars && 'eta' in vars ? `${key}(${vars.eta})` : key;

  it('gives the expected delivery date once the carrier has one', () => {
    // A carrier ETA is a calendar date; its UTC-midnight round trip must not
    // slip to the previous day in a western timezone.
    expect(trackingNote({ status: 'in_transit', trackingEta: '2026-09-22T00:00:00.000Z' }, tt, 'en-US'))
      .toBe('shipEstDelivery(Tue, Sep 22)');
  });

  it('says delivered or exception over any ETA — the chip alone would be stale', () => {
    expect(trackingNote({ status: 'delivered', trackingEta: '2026-09-22T00:00:00.000Z' }, tt, 'en-US'))
      .toBe('shipStatusDelivered');
    expect(trackingNote({ status: 'exception', trackingEta: null }, tt, 'en-US'))
      .toBe('shipStatusException');
  });

  it('says nothing before the first scan, and on a row from an older backend', () => {
    expect(trackingNote({ status: 'purchased', trackingEta: null }, tt, 'en-US')).toBeNull();
    expect(trackingNote({}, tt, 'en-US')).toBeNull();
  });
});
