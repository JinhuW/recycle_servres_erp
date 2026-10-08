import { expect } from 'vitest';
import { orderFingerprint } from '../../src/services/sellOrderSignoff';
import { api } from './app';
import { getTestDb } from './db';

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

// Every active manager signs the order as it stands, so a test about something
// else can move it to Done. tests/sell-order-signoff.test.ts covers the gate.
export async function signOffAll(sellOrderId: string): Promise<void> {
  const sql = getTestDb();
  const fp = await orderFingerprint(sql, sellOrderId);
  expect(fp).not.toBeNull();
  await sql`
    INSERT INTO sell_order_signoffs (sell_order_id, user_id, fingerprint)
    SELECT ${sellOrderId}, id, ${fp!} FROM users WHERE role = 'manager' AND active = TRUE
    ON CONFLICT (sell_order_id, user_id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint
  `;
}
