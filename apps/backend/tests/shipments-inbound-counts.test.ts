import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

// GET /api/shipments/inbound-counts — the two integers behind the home-screen
// inbound card. The SQL buckets must mirror groupInbound() in
// apps/frontend/src/lib/shippingInbound.ts; this file pins the truth table so
// a membership change on either side fails loudly.

const FROM = {
  name: 'Jordan Rivera',
  street1: '2210 E Speedway Blvd',
  city: 'Tucson',
  state: 'AZ',
  zip: '85719',
};
const PKG = { weightOz: 32, lengthIn: 10, widthIn: 8, heightIn: 6 };

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

async function createShipment(token: string, orderId: string, status?: string): Promise<string> {
  const r = await api<{ shipment: { id: string } }>('POST', `/api/orders/${orderId}/shipments`, {
    token, body: { from: FROM, package: PKG },
  });
  expect(r.status).toBe(201);
  const sid = r.body.shipment.id;
  if (status) await getTestDb()`UPDATE shipments SET status = ${status} WHERE id = ${sid}`;
  return sid;
}

async function createPackage(token: string, trackingNumber: string, status?: string, orderId?: string): Promise<string> {
  const r = await api<{ package: { id: string } }>('POST', '/api/packages', {
    token, body: { trackingNumber, carrier: 'UPS' },
  });
  expect(r.status).toBe(201);
  const id = r.body.package.id;
  const sql = getTestDb();
  if (status) await sql`UPDATE packages SET status = ${status} WHERE id = ${id}`;
  if (orderId) await sql`UPDATE packages SET order_id = ${orderId} WHERE id = ${id}`;
  return id;
}

type Counts = { moving: number; needs: number };

describe('GET /api/shipments/inbound-counts', () => {
  beforeEach(async () => { await resetDb(); });

  it('buckets every status the way groupInbound does', async () => {
    const marcus = await loginAs(MARCUS);
    const sql = getTestDb();

    const poOpen = await createPo(marcus.token);
    // needs: draft, quoted, exception, delivered on a not-done order
    await createShipment(marcus.token, poOpen);
    await createShipment(marcus.token, poOpen, 'quoted');
    await createShipment(marcus.token, poOpen, 'exception');
    await createShipment(marcus.token, poOpen, 'delivered');
    // moving: purchased, in_transit
    await createShipment(marcus.token, poOpen, 'purchased');
    await createShipment(marcus.token, poOpen, 'in_transit');
    // neither: voided
    await createShipment(marcus.token, poOpen, 'voided');
    // arrived, not needs: delivered on a done order
    const poDone = await createPo(marcus.token);
    await createShipment(marcus.token, poDone, 'delivered');
    await sql`UPDATE orders SET lifecycle = 'done' WHERE id = ${poDone}`;

    // Packages: counting is manager-blind, so an undelivered unlinked box is
    // "moving" even though a manager's card offers create-PO on it.
    await createPackage(marcus.token, 'INBCNT0001', 'purchased');
    await createPackage(marcus.token, 'INBCNT0002', 'delivered');            // needs: unlinked
    await createPackage(marcus.token, 'INBCNT0003', 'exception');            // needs
    await createPackage(marcus.token, 'INBCNT0004', 'delivered', poOpen);    // arrived: linked

    const r = await api<Counts>('GET', '/api/shipments/inbound-counts', { token: marcus.token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ moving: 3, needs: 6 });
  });

  it('scopes like the list: own rows for purchasers, org-wide for managers, ?mine narrows', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const mgr = await loginAs(ALEX);

    const poM = await createPo(marcus.token);
    await createShipment(marcus.token, poM);                       // needs (draft)
    await createPackage(marcus.token, 'INBCNT0011', 'in_transit'); // moving

    const poP = await createPo(priya.token);
    await createShipment(priya.token, poP, 'purchased');           // moving
    await createPackage(priya.token, 'INBCNT0012', 'delivered');   // needs

    const m = await api<Counts>('GET', '/api/shipments/inbound-counts', { token: marcus.token });
    expect(m.body).toEqual({ moving: 1, needs: 1 });

    const all = await api<Counts>('GET', '/api/shipments/inbound-counts', { token: mgr.token });
    expect(all.body).toEqual({ moving: 2, needs: 2 });

    const mine = await api<Counts>('GET', '/api/shipments/inbound-counts?mine=true', { token: mgr.token });
    expect(mine.body).toEqual({ moving: 0, needs: 0 });
  });
});

describe('GET /api/orders/:id — shipmentCount', () => {
  beforeEach(async () => { await resetDb(); });

  it('carries the label count so the detail page needs no second fetch', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await createPo(marcus.token);

    const before = await api<{ order: { shipmentCount: number } }>('GET', `/api/orders/${po}`, { token: marcus.token });
    expect(before.body.order.shipmentCount).toBe(0);

    await createShipment(marcus.token, po);
    await createShipment(marcus.token, po, 'purchased');

    const after = await api<{ order: { shipmentCount: number } }>('GET', `/api/orders/${po}`, { token: marcus.token });
    expect(after.body.order.shipmentCount).toBe(2);
  });
});
