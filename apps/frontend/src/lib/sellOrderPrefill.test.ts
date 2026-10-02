import { describe, it, expect, beforeEach } from 'vitest';
import {
  stashSellOrderPrefill, peekSellOrderPrefill, clearSellOrderPrefill,
} from './sellOrderPrefill';

describe('sellOrderPrefill', () => {
  beforeEach(() => {
    clearSellOrderPrefill('SO-1');
    clearSellOrderPrefill('SO-2');
  });

  it('peeks without consuming', () => {
    stashSellOrderPrefill({ orderId: 'SO-1', items: [] });
    expect(peekSellOrderPrefill('SO-1')?.orderId).toBe('SO-1');
    expect(peekSellOrderPrefill('SO-1')?.orderId).toBe('SO-1');
  });

  it('hands nothing to a different order', () => {
    stashSellOrderPrefill({ orderId: 'SO-1', items: [] });
    expect(peekSellOrderPrefill('SO-2')).toBeNull();
  });

  it('clears only the named order', () => {
    stashSellOrderPrefill({ orderId: 'SO-1', items: [] });
    clearSellOrderPrefill('SO-2');
    expect(peekSellOrderPrefill('SO-1')).not.toBeNull();
    clearSellOrderPrefill('SO-1');
    expect(peekSellOrderPrefill('SO-1')).toBeNull();
  });
});
