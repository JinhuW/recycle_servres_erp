import { describe, it, expect } from 'vitest';
import { ageTone, daysSince, managerTiles, poStagePath, STALE_BAD_DAYS, STALE_WARN_DAYS } from './home';
import type { ManagerHome } from './types';

const DAY = 86_400_000;

describe('daysSince / ageTone', () => {
  it('counts whole days and never goes negative', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(daysSince(new Date(now - 2.9 * DAY).toISOString(), now)).toBe(2);
    expect(daysSince(new Date(now + DAY).toISOString(), now)).toBe(0);
  });

  it('tints from the warn and bad thresholds on', () => {
    expect(ageTone(STALE_WARN_DAYS - 1)).toBe('ok');
    expect(ageTone(STALE_WARN_DAYS)).toBe('warn');
    expect(ageTone(STALE_BAD_DAYS)).toBe('bad');
  });
});

describe('managerTiles', () => {
  const m = {
    inbound: { moving: 4, needs: 1, arriving: 2, pickups: 0, items: [] },
    review: { count: 3, mine: 1, items: [] },
    reverts: { count: 0, items: [] },
    readyToPay: { count: 5, commission: 120 },
    sales: { draft: 0, draftConnector: 0, packing: 0, shipped: 0, awaitingPayment: 0, packingItems: [] },
    signoffs: { count: 2, items: [] },
    bank: { unlinked: 7, unlinkedAmount: 900, disputes: 0 },
    rmb: { forMe: 1, asked: 2 },
    queues: { afterSales: 0, afterSalesMine: 0, transfers: 0, web: 0 },
  } satisfies ManagerHome;

  it('opens each queue on the page that lists it', () => {
    const byKey = Object.fromEntries(managerTiles(m).map(x => [x.key, x]));
    expect(byKey.review).toMatchObject({ count: 3, to: poStagePath('reviewing') });
    expect(byKey.readyToPay).toMatchObject({ count: 5, to: '/purchase-orders?stage=ready_to_pay' });
    expect(byKey.rmb.count).toBe(3);
    expect(byKey.arriving.to).toBe('/shipping');
  });
});
