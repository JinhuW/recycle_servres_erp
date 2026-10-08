// Packing: a Draft whose goods are being boxed. Pack mode moves a Draft there.
// It sits between Draft and Shipped and, like a Draft, holds no stock — the
// claim is staked when it moves on to Shipped, Awaiting payment or Done.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { firstCustomerId, signOffAll } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';

const move = (token: string, id: string, to: string) =>
  api<{ error?: string; missingSignoff?: string[] }>('POST', `/api/sell-orders/${id}/status`, {
    token, body: { to },
  });

async function orderFor(token: string, lot: string, qty: number): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId: await firstCustomerId(token),
      lines: [{ inventoryId: lot, category: 'RAM', label: 'x', partNumber: 'PKG-PN', qty, unitPrice: 50 }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('sell order Packing status', () => {
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  it('is listed between Draft and Shipped, with no evidence asked', async () => {
    const r = await api<{ sellOrderStatuses: { id: string; needsMeta: boolean }[] }>(
      'GET', '/api/lookups', { token: mgr });
    expect(r.status).toBe(200);
    expect(r.body.sellOrderStatuses.map(s => s.id))
      .toEqual(['Draft', 'Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed']);
    expect(r.body.sellOrderStatuses.find(s => s.id === 'Packing')!.needsMeta).toBe(false);
  });

  it('goes Draft → Packing → Shipped, can step back to Draft, and is never re-entered from Shipped', async () => {
    const lot = await freeSellableLine(mgr);
    const id = await orderFor(mgr, lot.id, 1);
    expect((await move(mgr, id, 'Packing')).status).toBe(200);
    expect((await move(mgr, id, 'Draft')).status).toBe(200);
    expect((await move(mgr, id, 'Packing')).status).toBe(200);
    // A second iPad opening Pack mode asks for the status it already has.
    expect((await move(mgr, id, 'Packing')).status).toBe(200);
    expect((await move(mgr, id, 'Shipped')).status).toBe(200);
    expect((await move(mgr, id, 'Packing')).status).toBe(409);
    expect((await move(mgr, id, 'Draft')).status).toBe(409);
  });

  it('holds no stock: a rival can commit the lot, and leaving Packing is where it is checked', async () => {
    const lot = await freeSellableLine(mgr);
    const ours = await orderFor(mgr, lot.id, lot.qty);
    const rival = await orderFor(mgr, lot.id, lot.qty);
    expect((await move(mgr, ours, 'Packing')).status).toBe(200);
    expect((await move(mgr, rival, 'Shipped')).status).toBe(200);
    // Entering Pack mode never fails on a rival's claim…
    expect((await move(mgr, ours, 'Draft')).status).toBe(200);
    expect((await move(mgr, ours, 'Packing')).status).toBe(200);
    // …promotion does.
    for (const to of ['Shipped', 'Awaiting payment', 'Done']) {
      const r = await move(mgr, ours, to);
      expect(r.status).toBe(409);
      expect(r.body.missingSignoff).toBeUndefined();
    }
  });

  it('needs every sign-off before Done', async () => {
    const lot = await freeSellableLine(mgr);
    const id = await orderFor(mgr, lot.id, 1);
    expect((await move(mgr, id, 'Packing')).status).toBe(200);
    const refused = await move(mgr, id, 'Done');
    expect(refused.status).toBe(409);
    expect(refused.body.missingSignoff?.length).toBeGreaterThan(0);
    await signOffAll(id);
    expect((await move(mgr, id, 'Done')).status).toBe(200);
  });

  it('cannot be archived', async () => {
    const lot = await freeSellableLine(mgr);
    const id = await orderFor(mgr, lot.id, 1);
    expect((await move(mgr, id, 'Packing')).status).toBe(200);
    const r = await api<{ error: string }>('POST', `/api/sell-orders/${id}/archive`, { token: mgr });
    expect(r.status).toBe(403);
  });
});
