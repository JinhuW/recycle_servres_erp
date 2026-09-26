import { expect } from 'vitest';
import { api } from './app';

export async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

// One-line RAM sell order for `qty` of `lineId`, created by `mgr`.
export async function createSellOrderOn(
  mgr: string, lineId: string, partNumber: string, qty = 1, unitPrice = 90,
): Promise<string> {
  const so = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: mgr,
    body: {
      customerId: await firstCustomerId(mgr),
      lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber, qty, unitPrice }],
    },
  });
  expect(so.status).toBe(201);
  return so.body.id;
}
