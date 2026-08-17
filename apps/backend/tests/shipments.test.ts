import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { refreshShipmentTracking } from '../src/shipping/track';
import { stubShippingClient } from '../src/shipping/stub';

type Shipment = {
  id: string;
  status: string;
  provider: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  labelCost: number | null;
  carrier: string | null;
  service: string | null;
};
type Rate = { rateId: string; carrier: string; amount: number };
type OrderApi = { id: string; otherFees?: number; otherFeesNote?: string | null };

const FROM = {
  name: 'Jordan Rivera',
  street1: '2210 E Speedway Blvd',
  city: 'Tucson',
  state: 'AZ',
  zip: '85719',
};
const PKG = { weightOz: 32, lengthIn: 10, widthIn: 8, heightIn: 6 };

const SHIP_ADDR = {
  shipContactName: 'Recycle Servers LLC',
  shipStreet1: '4880 Ironton St',
  shipCity: 'Denver',
  shipState: 'CO',
  shipZip: '80239',
};

async function createPo(token: string, warehouseId: string | null = 'WH-LA1'): Promise<string> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      ...(warehouseId ? { warehouseId } : {}),
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber: 'SHIP-TEST-1', condition: 'Pulled — Tested', qty: 4, unitCost: 100,
      }],
    },
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function setWarehouseAddress(managerToken: string, id = 'WH-LA1'): Promise<void> {
  const r = await api('PATCH', `/api/warehouses/${id}`, { token: managerToken, body: SHIP_ADDR });
  expect(r.status).toBe(200);
}

async function createShipment(token: string, orderId: string): Promise<Shipment> {
  const r = await api<{ shipment: Shipment }>('POST', `/api/orders/${orderId}/shipments`, {
    token,
    body: { from: FROM, package: PKG },
  });
  expect(r.status).toBe(201);
  return r.body.shipment;
}

async function quoteAndBuy(token: string, orderId: string, sid: string): Promise<Shipment> {
  const rates = await api<{ rates: Rate[] }>('POST', `/api/orders/${orderId}/shipments/${sid}/rates`, { token });
  expect(rates.status).toBe(200);
  const usps = rates.body.rates.find((r) => r.rateId === 'stub-usps-priority')!;
  const buy = await api<{ shipment: Shipment }>('POST', `/api/orders/${orderId}/shipments/${sid}/buy`, {
    token,
    body: { rateId: usps.rateId, expectedAmount: usps.amount },
  });
  expect(buy.status).toBe(200);
  return buy.body.shipment;
}

async function getOrder(token: string, id: string): Promise<OrderApi> {
  const r = await api<{ order: OrderApi }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order;
}

describe('shipments — CRUD and role guards', () => {
  beforeEach(async () => { await resetDb(); });

  it('owner purchaser creates a draft shipment; non-owner purchaser is refused; manager allowed', async () => {
    const owner = await loginAs(MARCUS);
    const other = await loginAs(PRIYA);
    const mgr = await loginAs(ALEX);
    const po = await createPo(owner.token);

    const s = await createShipment(owner.token, po);
    expect(s.status).toBe('draft');
    expect(s.provider).toBe('stub');

    const denied = await api('POST', `/api/orders/${po}/shipments`, {
      token: other.token, body: { from: FROM, package: PKG },
    });
    expect(denied.status).toBe(403);

    const viaMgr = await api('POST', `/api/orders/${po}/shipments`, {
      token: mgr.token, body: { from: FROM, package: PKG },
    });
    expect(viaMgr.status).toBe(201);

    const list = await api<{ items: Shipment[] }>('GET', `/api/orders/${po}/shipments`, { token: other.token });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
  });

  it('rejects a missing address field and a non-positive dimension', async () => {
    const { token } = await loginAs(MARCUS);
    const po = await createPo(token);

    const noCity = await api('POST', `/api/orders/${po}/shipments`, {
      token, body: { from: { ...FROM, city: ' ' }, package: PKG },
    });
    expect(noCity.status).toBe(400);

    const badWeight = await api('POST', `/api/orders/${po}/shipments`, {
      token, body: { from: FROM, package: { ...PKG, weightOz: 0 } },
    });
    expect(badWeight.status).toBe(400);
  });

  it('PATCH edits reset a quoted shipment back to draft; delete works for drafts only', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const s = await createShipment(token, po);

    const rates = await api('POST', `/api/orders/${po}/shipments/${s.id}/rates`, { token });
    expect(rates.status).toBe(200);

    const patched = await api<{ shipment: Shipment }>('PATCH', `/api/orders/${po}/shipments/${s.id}`, {
      token, body: { from: FROM, package: { ...PKG, weightOz: 48 } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.shipment.status).toBe('draft');

    const del = await api('DELETE', `/api/orders/${po}/shipments/${s.id}`, { token });
    expect(del.status).toBe(200);
  });
});

describe('shipments — warehouse address requirement', () => {
  beforeEach(async () => { await resetDb(); });

  it('blocks rates until the warehouse has a shipping address, then returns stub rates', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    const po = await createPo(token);
    const s = await createShipment(token, po);

    const blocked = await api<{ error: string }>('POST', `/api/orders/${po}/shipments/${s.id}/rates`, { token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/no shipping address/i);

    await setWarehouseAddress(mgr.token);
    const rates = await api<{ rates: Rate[] }>('POST', `/api/orders/${po}/shipments/${s.id}/rates`, { token });
    expect(rates.status).toBe(200);
    expect(rates.body.rates).toHaveLength(3);
  });
});

describe('shipments — buy folds the label cost into the PO', () => {
  beforeEach(async () => { await resetDb(); });

  it('stub end-to-end: buy → purchased row, tracking, label URL, fee fold, audit, notification', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const before = await getOrder(token, po);
    const s = await createShipment(token, po);
    const bought = await quoteAndBuy(token, po, s.id);

    expect(bought.status).toBe('purchased');
    expect(bought.carrier).toBe('USPS');
    expect(bought.trackingNumber).toMatch(/^STUB/);
    expect(bought.labelUrl).toBeTruthy();
    expect(bought.labelCost).toBe(12.45);

    const after = await getOrder(token, po);
    expect((after.otherFees ?? 0) - (before.otherFees ?? 0)).toBeCloseTo(12.45, 2);
    expect(after.otherFeesNote).toContain('Shipping label');

    const ev = await api<{ events: Array<{ kind: string }> }>('GET', `/api/orders/${po}/events`, { token });
    expect(ev.body.events.map((e) => e.kind)).toContain('shipment_purchased');

    const sql = getTestDb();
    const notes = await sql`
      SELECT n.title FROM notifications n
      JOIN users u ON u.id = n.user_id
      WHERE n.kind = 'shipment_purchased' AND u.role = 'manager'
    `;
    expect(notes.length).toBeGreaterThan(0);
  });

  it('enforces the status guard: no buy on a draft, no double-buy, no void on a draft', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const s = await createShipment(token, po);

    const early = await api('POST', `/api/orders/${po}/shipments/${s.id}/buy`, {
      token, body: { rateId: 'stub-usps-priority' },
    });
    expect(early.status).toBe(409);

    const voidEarly = await api('POST', `/api/orders/${po}/shipments/${s.id}/void`, { token });
    expect(voidEarly.status).toBe(409);

    await quoteAndBuy(token, po, s.id);
    const again = await api('POST', `/api/orders/${po}/shipments/${s.id}/buy`, {
      token, body: { rateId: 'stub-usps-priority' },
    });
    expect(again.status).toBe(409);
  });
});

describe('shipments — void reverts the fee', () => {
  beforeEach(async () => { await resetDb(); });

  it('void → voided, fee removed, second void refused', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const before = await getOrder(token, po);
    const s = await createShipment(token, po);
    await quoteAndBuy(token, po, s.id);

    const voided = await api<{ shipment: Shipment }>('POST', `/api/orders/${po}/shipments/${s.id}/void`, { token });
    expect(voided.status).toBe(200);
    expect(voided.body.shipment.status).toBe('voided');

    const after = await getOrder(token, po);
    expect(after.otherFees ?? 0).toBeCloseTo(before.otherFees ?? 0, 2);

    const again = await api('POST', `/api/orders/${po}/shipments/${s.id}/void`, { token });
    expect(again.status).toBe(409);
  });

  it('GREATEST guard: a manual fee cut below the label cost cannot drive other_fees negative', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const s = await createShipment(token, po);
    await quoteAndBuy(token, po, s.id);

    // Manager manually zeroes the fee stack after the buy.
    const cut = await api('PATCH', `/api/orders/${po}`, { token: mgr.token, body: { otherFees: 0 } });
    expect(cut.status).toBe(200);

    const voided = await api('POST', `/api/orders/${po}/shipments/${s.id}/void`, { token });
    expect(voided.status).toBe(200);
    const after = await getOrder(token, po);
    expect(after.otherFees ?? 0).toBe(0);
  });
});

describe('shipments — order deletion guard', () => {
  beforeEach(async () => { await resetDb(); });

  it('a draft PO with a purchased label cannot be deleted until the label is voided', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const s = await createShipment(token, po);
    await quoteAndBuy(token, po, s.id);

    const del = await api<{ error: string }>('DELETE', `/api/orders/${po}`, { token });
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/shipping label/i);

    await api('POST', `/api/orders/${po}/shipments/${s.id}/void`, { token });
    const delAfter = await api('DELETE', `/api/orders/${po}`, { token });
    expect(delAfter.status).toBe(200);
  });
});

describe('shipments — tracking refresh', () => {
  beforeEach(async () => { await resetDb(); });

  it('moves purchased → in_transit with an ETA; leaves terminal rows alone', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const s = await createShipment(token, po);
    await quoteAndBuy(token, po, s.id);

    const sql = getTestDb();
    // The poll only touches provider='shipsaving' rows; retag the stub buy.
    await sql`UPDATE shipments SET provider = 'shipsaving' WHERE id = ${s.id}`;

    const res = await refreshShipmentTracking(sql, stubShippingClient);
    expect(res.checked).toBe(1);
    expect(res.updated).toBe(1);

    const row = (await sql`
      SELECT status, tracking_eta, last_tracked_at FROM shipments WHERE id = ${s.id}
    `)[0] as { status: string; tracking_eta: Date | null; last_tracked_at: Date | null };
    expect(row.status).toBe('in_transit');
    expect(row.tracking_eta).not.toBeNull();
    expect(row.last_tracked_at).not.toBeNull();

    // Delivered is terminal: the stub's in_transit answer must not regress it.
    await sql`UPDATE shipments SET status = 'delivered' WHERE id = ${s.id}`;
    const res2 = await refreshShipmentTracking(sql, stubShippingClient);
    expect(res2.checked).toBe(0);
  });
});

describe('shipments — done lifecycle freeze', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses buy and void once the PO is done', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const s = await createShipment(token, po);
    await quoteAndBuy(token, po, s.id);
    const s2 = await createShipment(token, po);
    const rates = await api('POST', `/api/orders/${po}/shipments/${s2.id}/rates`, { token });
    expect(rates.status).toBe(200);

    const sql = getTestDb();
    await sql`UPDATE orders SET lifecycle = 'done' WHERE id = ${po}`;

    const buy = await api('POST', `/api/orders/${po}/shipments/${s2.id}/buy`, {
      token, body: { rateId: 'stub-usps-priority' },
    });
    expect(buy.status).toBe(409);

    const voidReq = await api('POST', `/api/orders/${po}/shipments/${s.id}/void`, { token });
    expect(voidReq.status).toBe(409);
  });
});

describe('shipments — seller self-service fill', () => {
  beforeEach(async () => { await resetDb(); });

  it('sellerFill creates an empty shell with a token; rates refuse until the seller submits', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);

    const created = await api<{ shipment: Shipment & { sellerToken: string | null; complete: boolean } }>(
      'POST', `/api/orders/${po}/shipments`, { token, body: { sellerFill: true } },
    );
    expect(created.status).toBe(201);
    const s = created.body.shipment;
    expect(s.sellerToken).toBeTruthy();
    expect(s.complete).toBe(false);

    const rates = await api<{ error: string }>('POST', `/api/orders/${po}/shipments/${s.id}/rates`, { token });
    expect(rates.status).toBe(409);
    expect(rates.body.error).toMatch(/seller/i);
  });

  it('public fill: seller GETs, POSTs address+package (no auth), owner is notified, rates unlock', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const created = await api<{ shipment: { id: string; sellerToken: string } }>(
      'POST', `/api/orders/${po}/shipments`, { token, body: { sellerFill: true } },
    );
    const sid = created.body.shipment.id;
    const st = created.body.shipment.sellerToken;

    // No auth cookie on either public call.
    const peek = await api<{ submitted: boolean; destination: string | null }>(
      'GET', `/api/public/shipping/${st}`, {},
    );
    expect(peek.status).toBe(200);
    expect(peek.body.submitted).toBe(false);

    const fill = await api('POST', `/api/public/shipping/${st}`, {
      body: { from: FROM, package: PKG },
    });
    expect(fill.status).toBe(200);

    const list = await api<{ items: Array<{ id: string; complete: boolean }> }>(
      'GET', `/api/orders/${po}/shipments`, { token },
    );
    expect(list.body.items.find((i) => i.id === sid)!.complete).toBe(true);

    const sql = getTestDb();
    const notes = await sql`
      SELECT 1 FROM notifications WHERE kind = 'shipment_seller_filled'
    `;
    expect(notes.length).toBe(1);

    const ev = await api<{ events: Array<{ kind: string }> }>('GET', `/api/orders/${po}/events`, { token });
    expect(ev.body.events.map((e) => e.kind)).toContain('shipment_seller_filled');

    const rates = await api<{ rates: Rate[] }>('POST', `/api/orders/${po}/shipments/${sid}/rates`, { token });
    expect(rates.status).toBe(200);
    expect(rates.body.rates).toHaveLength(3);
  });

  it('unknown tokens 404 uniformly, and a bought shipment kills its link', async () => {
    const mgr = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    await setWarehouseAddress(mgr.token);
    const po = await createPo(token);
    const created = await api<{ shipment: { id: string; sellerToken: string } }>(
      'POST', `/api/orders/${po}/shipments`, { token, body: { sellerFill: true } },
    );
    const sid = created.body.shipment.id;
    const st = created.body.shipment.sellerToken;

    const bogus = await api('GET', '/api/public/shipping/not-a-real-token', {});
    expect(bogus.status).toBe(404);

    await api('POST', `/api/public/shipping/${st}`, { body: { from: FROM, package: PKG } });
    await quoteAndBuy(token, po, sid);

    const dead = await api('GET', `/api/public/shipping/${st}`, {});
    expect(dead.status).toBe(404);
    const deadPost = await api('POST', `/api/public/shipping/${st}`, {
      body: { from: FROM, package: PKG },
    });
    expect(deadPost.status).toBe(404);
  });

  it('seller-link endpoint re-issues a token for an existing draft', async () => {
    const { token } = await loginAs(MARCUS);
    const po = await createPo(token);
    const s = await createShipment(token, po);

    const link = await api<{ sellerToken: string }>(
      'POST', `/api/orders/${po}/shipments/${s.id}/seller-link`, { token },
    );
    expect(link.status).toBe(200);
    expect(link.body.sellerToken).toBeTruthy();

    const peek = await api('GET', `/api/public/shipping/${link.body.sellerToken}`, {});
    expect(peek.status).toBe(200);
  });
});

describe('warehouses — shipping address round-trip', () => {
  beforeEach(async () => { await resetDb(); });

  it('PATCH stores the ship fields and GET returns them', async () => {
    const { token } = await loginAs(ALEX);
    await setWarehouseAddress(token);
    const r = await api<{ items: Array<{ id: string; shipStreet1: string | null; shipCity: string | null }> }>(
      'GET', '/api/warehouses', { token },
    );
    const la = r.body.items.find((w) => w.id === 'WH-LA1')!;
    expect(la.shipStreet1).toBe('4880 Ironton St');
    expect(la.shipCity).toBe('Denver');
  });
});
