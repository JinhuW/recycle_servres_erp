import { describe, it, expect } from 'vitest';
import { pathToDesktopView, match, activityRecordHref } from '../src/lib/route';

describe('match', () => {
  it('matches a single param segment', () => {
    expect(match('/sell-orders/:id', '/sell-orders/SO-1')).toEqual({ id: 'SO-1' });
  });
  it('does not match when segment counts differ', () => {
    expect(match('/sell-orders/:id', '/sell-orders/SO-1/edit')).toBeNull();
  });
  it('matches the two-param edit shape', () => {
    expect(match('/sell-orders/:id/edit', '/sell-orders/SO-1/edit')).toEqual({ id: 'SO-1' });
  });
});

describe('pathToDesktopView — sell orders', () => {
  it('resolves the list path', () => {
    expect(pathToDesktopView('/sell-orders')).toBe('sellorders');
  });
  it('resolves a sell-order view deep link', () => {
    expect(pathToDesktopView('/sell-orders/SO-1289')).toBe('sellorders');
  });
  it('resolves a sell-order edit deep link', () => {
    expect(pathToDesktopView('/sell-orders/SO-1289/edit')).toBe('sellorders');
  });
});

describe('pathToDesktopView — unchanged behaviour', () => {
  it('still resolves purchase-order deep links', () => {
    expect(pathToDesktopView('/purchase-orders/SO-1')).toBe('history');
  });
  it('defaults unknown paths to dashboard', () => {
    expect(pathToDesktopView('/nope')).toBe('dashboard');
  });
});

describe('pathToDesktopView — transfers', () => {
  it('resolves the transfers path', () => {
    expect(pathToDesktopView('/transfers')).toBe('transfers');
  });
});

describe('activityRecordHref', () => {
  it('hash-prefixes a purchase-order link', () => {
    expect(activityRecordHref('po', 'PO-1366')).toBe('#/purchase-orders/PO-1366');
  });
  it('hash-prefixes a sell-order link', () => {
    expect(activityRecordHref('so', 'SO-1289')).toBe('#/sell-orders/SO-1289');
  });
  it('hash-prefixes an inventory link', () => {
    expect(activityRecordHref('inv', 'a1b2')).toBe('#/inventory/a1b2');
  });
  it('sends price events to the market page', () => {
    expect(activityRecordHref('price', 'rp-1')).toBe('#/market');
  });
  it('lands on a route the desktop shell recognises', () => {
    const href = activityRecordHref('po', 'PO-1366')!;
    expect(pathToDesktopView(href.slice(1))).toBe('history');
  });
  it('encodes ids that carry URL-significant characters', () => {
    expect(activityRecordHref('po', 'PO/1?2')).toBe('#/purchase-orders/PO%2F1%3F2');
  });
  it('has no link when the event carries no target', () => {
    expect(activityRecordHref('po', null)).toBeNull();
  });
});
