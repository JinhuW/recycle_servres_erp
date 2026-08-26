import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

// GET /api/shipments (cross-PO list) and GET /api/shipping/contacts (seller
// address book) — the server-side replacements for the frontend's 31-request
// compositions.

type ListItem = {
  id: string;
  status: string;
  createdAt: string;
  from: { name: string | null };
  order: {
    id: string;
    userName: string;
    lifecycle: string;
    paypalTxnId: string | null;
    warehouse: { id: string; name: string | null; short: string; region: string } | null;
  };
};
type Contact = {
  key: string;
  label: string;
  from: { name: string; street1: string; zip: string };
  count: number;
  lastUsed: string;
};

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
        partNumber: 'SHIP-LIST-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
      }],
    },
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function createShipment(token: string, orderId: string, from = FROM): Promise<string> {
  const r = await api<{ shipment: { id: string } }>('POST', `/api/orders/${orderId}/shipments`, {
    token, body: { from, package: PKG },
  });
  expect(r.status).toBe(201);
  return r.body.shipment.id;
}

describe('GET /api/shipments — scope and join', () => {
  beforeEach(async () => { await resetDb(); });

  it('purchasers see their own orders’ shipments; managers see all, ?mine narrows', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const mgr = await loginAs(ALEX);

    const poM = await createPo(marcus.token);
    await createShipment(marcus.token, poM);
    const poP = await createPo(priya.token);
    await createShipment(priya.token, poP);

    const own = await api<{ items: ListItem[] }>('GET', '/api/shipments', { token: marcus.token });
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(1);
    expect(own.body.items[0].order.id).toBe(poM);

    const all = await api<{ items: ListItem[] }>('GET', '/api/shipments', { token: mgr.token });
    expect(all.body.items).toHaveLength(2);

    const mine = await api<{ items: ListItem[] }>('GET', '/api/shipments?mine=true', { token: mgr.token });
    expect(mine.body.items).toHaveLength(0);
  });

  it('joins exactly the order fields the table renders', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await createPo(marcus.token);
    await createShipment(marcus.token, po);
    const patched = await api('PATCH', `/api/orders/${po}`, {
      token: marcus.token, body: { paypalTxnId: '8AB12345CD678901E' },
    });
    expect(patched.status).toBe(200);

    const r = await api<{ items: ListItem[] }>('GET', '/api/shipments', { token: marcus.token });
    const item = r.body.items[0];
    expect(item.order.id).toBe(po);
    expect(item.order.userName).toBeTruthy();
    expect(item.order.lifecycle).toBe('draft');
    expect(item.order.paypalTxnId).toBe('8AB12345CD678901E');
    expect(item.order.warehouse?.id).toBe('WH-LA1');
    expect(item.order.warehouse?.short).toBeTruthy();
    expect(item.from.name).toBe(FROM.name);
  });

  it('pages newest-first on a keyset cursor without overlap', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await createPo(marcus.token);
    const ids = [
      await createShipment(marcus.token, po),
      await createShipment(marcus.token, po),
      await createShipment(marcus.token, po),
    ];

    const p1 = await api<{ items: ListItem[]; nextCursor: string | null }>(
      'GET', '/api/shipments?limit=2', { token: marcus.token });
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();

    const p2 = await api<{ items: ListItem[]; nextCursor: string | null }>(
      'GET', `/api/shipments?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor!)}`,
      { token: marcus.token });
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();

    const seen = [...p1.body.items, ...p2.body.items].map(i => i.id);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('a malformed cursor falls back to the first page instead of a cast 500', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await createPo(marcus.token);
    await createShipment(marcus.token, po);

    // Valid base64url of JSON that is not a {ts, id} cursor.
    const garbage = Buffer.from(JSON.stringify({ ts: { nested: true } })).toString('base64url');
    const r = await api<{ items: ListItem[] }>(
      'GET', `/api/shipments?cursor=${encodeURIComponent(garbage)}`, { token: marcus.token });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);

    // Shape-valid but uncastable values — would 22007/22P02 inside the
    // ::timestamptz/::uuid casts without the value guard.
    const uncastable = Buffer.from(JSON.stringify({ ts: 'x', id: 'y' })).toString('base64url');
    const r2 = await api<{ items: ListItem[] }>(
      'GET', `/api/shipments?cursor=${encodeURIComponent(uncastable)}`, { token: marcus.token });
    expect(r2.status).toBe(200);
    expect(r2.body.items).toHaveLength(1);
  });
});

describe('GET /api/shipping/contacts — seller address book', () => {
  beforeEach(async () => { await resetDb(); });

  it('dedupes on name+street+zip with counts, newest first, skipping incomplete rows', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await createPo(marcus.token);
    await createShipment(marcus.token, po, FROM);
    await createShipment(marcus.token, po, FROM);
    await createShipment(marcus.token, po, { ...FROM, name: 'Casey Wu', street1: '9 Elm St' });
    // A seller-fill shell has no address yet — it must not become a contact.
    const shell = await api('POST', `/api/orders/${po}/shipments`, {
      token: marcus.token, body: { sellerFill: true },
    });
    expect(shell.status).toBe(201);

    const r = await api<{ items: Contact[] }>('GET', '/api/shipping/contacts', { token: marcus.token });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].from.name).toBe('Casey Wu'); // newest first
    const jordan = r.body.items.find(i => i.from.name === FROM.name)!;
    expect(jordan.count).toBe(2);
    expect(jordan.label).toBe('Jordan Rivera · Tucson, AZ');
  });

  it('is scoped like the list: another purchaser sees nothing', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const po = await createPo(marcus.token);
    await createShipment(marcus.token, po);

    const r = await api<{ items: Contact[] }>('GET', '/api/shipping/contacts', { token: priya.token });
    expect(r.body.items).toHaveLength(0);
    const mgr = await loginAs(ALEX);
    const all = await api<{ items: Contact[] }>('GET', '/api/shipping/contacts', { token: mgr.token });
    expect(all.body.items).toHaveLength(1);
  });
});
