import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

// GET /api/packages/inbound-counts — the two integers behind the home-screen
// inbound card. The SQL buckets must mirror groupInbound() in
// apps/frontend/src/lib/shippingInbound.ts; this file pins the truth table so
// a membership change on either side fails loudly.

async function createPo(token: string): Promise<string> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      warehouseId: 'WH-LA1',
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber: 'INB-COUNT-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
      }],
    },
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function createPackage(token: string, trackingNumber: string, status?: string, orderId?: string): Promise<string> {
  const r = await api<{ package: { id: string } }>('POST', '/api/packages', {
    token, body: { trackingNumber, carrier: 'UPS', source: 'other' },
  });
  expect(r.status).toBe(201);
  const id = r.body.package.id;
  const sql = getTestDb();
  if (status) await sql`UPDATE packages SET status = ${status} WHERE id = ${id}`;
  if (orderId) await sql`UPDATE packages SET order_id = ${orderId} WHERE id = ${id}`;
  return id;
}

type Counts = { moving: number; needs: number };

describe('GET /api/packages/inbound-counts', () => {
  beforeEach(async () => { await resetDb(); });

  it('buckets every status the way groupInbound does', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await createPo(marcus.token);

    // Counting is manager-blind, so an undelivered unlinked box is "moving"
    // even though a manager's card offers create-PO on it.
    await createPackage(marcus.token, 'INBCNT0001', 'purchased');        // moving
    await createPackage(marcus.token, 'INBCNT0005', 'in_transit');       // moving
    await createPackage(marcus.token, 'INBCNT0002', 'delivered');        // needs: unlinked
    await createPackage(marcus.token, 'INBCNT0003', 'exception');        // needs
    await createPackage(marcus.token, 'INBCNT0004', 'delivered', po);    // arrived: linked

    const r = await api<Counts>('GET', '/api/packages/inbound-counts', { token: marcus.token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ moving: 2, needs: 2 });
  });

  it('scopes like the list: own rows for purchasers, org-wide for managers, ?mine narrows', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const mgr = await loginAs(ALEX);

    await createPackage(marcus.token, 'INBCNT0011', 'in_transit'); // moving
    await createPackage(priya.token, 'INBCNT0012', 'delivered');   // needs

    const m = await api<Counts>('GET', '/api/packages/inbound-counts', { token: marcus.token });
    expect(m.body).toEqual({ moving: 1, needs: 0 });

    const all = await api<Counts>('GET', '/api/packages/inbound-counts', { token: mgr.token });
    expect(all.body).toEqual({ moving: 1, needs: 1 });

    const mine = await api<Counts>('GET', '/api/packages/inbound-counts?mine=true', { token: mgr.token });
    expect(mine.body).toEqual({ moving: 0, needs: 0 });
  });
});
