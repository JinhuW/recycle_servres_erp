import { describe, it, expect } from 'vitest';
import { openSellOrders, type SellOrderPick } from './openSellOrders';

const so = (id: string, status: string, name: string, short: string | null = null): SellOrderPick => ({
  id, status, customer: { name, short }, lineCount: 1, qty: 1, total: 0, createdAt: '2026-09-24',
});

const rows = [
  so('SO-4001', 'Draft', 'Acme Servers', 'ACME'),
  so('SO-4002', 'Shipped', 'Bravo Parts'),
  so('SO-4003', 'Awaiting payment', 'Charlie IT'),
  so('SO-4004', 'Done', 'Acme Servers', 'ACME'),
  so('SO-4005', 'Closed', 'Bravo Parts'),
];

describe('openSellOrders', () => {
  it('drops the locked statuses', () => {
    expect(openSellOrders(rows, '').map(o => o.id)).toEqual(['SO-4001', 'SO-4002', 'SO-4003']);
  });

  it('matches order id, customer name and short name, case-insensitively', () => {
    expect(openSellOrders(rows, 'so-4002').map(o => o.id)).toEqual(['SO-4002']);
    expect(openSellOrders(rows, 'charlie').map(o => o.id)).toEqual(['SO-4003']);
    expect(openSellOrders(rows, ' acme ').map(o => o.id)).toEqual(['SO-4001']);
  });
});
