import { describe, it, expect } from 'vitest';
import { pathToDesktopView, match } from '../src/lib/route';

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
