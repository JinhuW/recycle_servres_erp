// Seeding the book from shipping history, and the purchase-order link that
// makes "what they sold us" derive itself.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

type Sugg = {
  matchKey: string; name: string; poCount: number; spend: number;
  city: string | null; zip: string | null; phone: string | null;
  street1: string | null; source: string;
};

async function seedHistory(email: string, opts: {
  order: string; seller: string; zip?: string; street?: string; cost: number;
  viaPackage?: boolean; tracking?: string;
}) {
  const sql = getTestDb();
  const [{ id: userId }] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  const [{ id: whId }] = await sql<{ id: string }[]>`SELECT id FROM warehouses LIMIT 1`;
  await sql`
    INSERT INTO orders (id, user_id, category, warehouse_id, lifecycle, total_cost, created_at)
    VALUES (${opts.order}, ${userId}, 'RAM', ${whId}, 'done', ${opts.cost}, NOW() - INTERVAL '20 days')`;
  if (opts.viaPackage) {
    await sql`
      INSERT INTO packages (tracking_number, carrier, order_id, seller_name)
      VALUES (${opts.tracking ?? opts.order}, 'UPS', ${opts.order}, ${opts.seller})`;
  } else {
    await sql`
      INSERT INTO shipments (order_id, from_name, from_phone, from_street1, from_city,
                             from_state, from_zip, weight_oz, length_in, width_in, height_in, provider)
      VALUES (${opts.order}, ${opts.seller}, '303-555-0142', ${opts.street ?? '1 Main St'},
              'Aurora', 'CO', ${opts.zip ?? '80012'}, 10, 1, 1, 1, 'stub')`;
  }
}

describe('suggestions', () => {
  beforeEach(async () => { await resetDb(); });

  it('offers sellers you have shipped with, with their history attached', async () => {
    await seedHistory(MARCUS, { order: 'PO-S001', seller: 'Denver Datacenter Liquidators', cost: 8400 });
    await seedHistory(MARCUS, { order: 'PO-S002', seller: "denver datacenter liquidators!", cost: 3000 });
    const marcus = await loginAs(MARCUS);
    const r = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    const hit = r.body.items.find((i) => /Denver/i.test(i.name))!;
    // two spellings collapse to one suggestion carrying both orders
    expect(hit.poCount).toBe(2);
    expect(hit.spend).toBe(11400);
    expect(hit.phone).toBe('303-555-0142');
    expect(hit.source).toBe('shipping');
  });

  it("never offers another purchaser's sellers", async () => {
    await seedHistory(PRIYA, { order: 'PO-S010', seller: 'Summit IT', cost: 900 });
    const marcus = await loginAs(MARCUS);
    const r = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    expect(r.body.items.find((i) => i.name === 'Summit IT')).toBeUndefined();
  });

  it('drops a seller once they are in the book', async () => {
    await seedHistory(MARCUS, { order: 'PO-S020', seller: 'Boulder Server Exchange', cost: 500 });
    const marcus = await loginAs(MARCUS);
    const before = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    const s = before.body.items.find((i) => /Boulder/.test(i.name))!;
    await api('POST', '/api/suppliers/adopt', { token: marcus.token, body: s });
    const after = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    expect(after.body.items.find((i) => /Boulder/.test(i.name))).toBeUndefined();
  });

  it('keeps a dismissed seller dismissed, and can restore them', async () => {
    await seedHistory(MARCUS, { order: 'PO-S030', seller: 'One Time Larry', cost: 120 });
    const marcus = await loginAs(MARCUS);
    const r1 = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    const key = r1.body.items.find((i) => /Larry/.test(i.name))!.matchKey;

    await api('POST', '/api/suppliers/suggestions/dismiss', { token: marcus.token, body: { matchKey: key } });
    const r2 = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    expect(r2.body.items.find((i) => /Larry/.test(i.name))).toBeUndefined();

    await api('POST', '/api/suppliers/suggestions/restore', { token: marcus.token, body: { matchKey: key } });
    const r3 = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    expect(r3.body.items.find((i) => /Larry/.test(i.name))).toBeDefined();
  });

  it("one purchaser's dismissal does not hide the seller from another", async () => {
    await seedHistory(MARCUS, { order: 'PO-S040', seller: 'Shared Seller', cost: 700 });
    await seedHistory(PRIYA, { order: 'PO-S041', seller: 'Shared Seller', cost: 700 });
    const marcus = await loginAs(MARCUS);
    const r1 = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: marcus.token });
    await api('POST', '/api/suppliers/suggestions/dismiss', {
      token: marcus.token, body: { matchKey: r1.body.items[0].matchKey } });
    const priya = await loginAs(PRIYA);
    const r2 = await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions', { token: priya.token });
    expect(r2.body.items.find((i) => i.name === 'Shared Seller')).toBeDefined();
  });
});

describe('adopt', () => {
  beforeEach(async () => { await resetDb(); });

  it('links every past order so the record is useful immediately', async () => {
    await seedHistory(MARCUS, { order: 'PO-A001', seller: 'Front Range Recyclers', cost: 5000 });
    await seedHistory(MARCUS, { order: 'PO-A002', seller: 'FRONT RANGE RECYCLERS', cost: 7000 });
    const marcus = await loginAs(MARCUS);
    const s = (await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions',
      { token: marcus.token })).body.items[0];

    const r = await api<{ id: string; linked: number }>('POST', '/api/suppliers/adopt',
      { token: marcus.token, body: s });
    expect(r.status).toBe(201);
    expect(r.body.linked).toBe(2);

    const d = await api<{ poCount: number; spendTotal: number; notes: { body: string }[] }>(
      'GET', `/api/suppliers/${r.body.id}`, { token: marcus.token });
    expect(d.body.poCount).toBe(2);
    expect(d.body.spendTotal).toBe(12000);
    expect(d.body.notes[0].body).toMatch(/2 past purchase orders linked/);
  });

  it('links a package-only seller by name, since a package carries no address', async () => {
    await seedHistory(MARCUS, { order: 'PO-A010', seller: 'Mike Trujillo', cost: 340,
      viaPackage: true, tracking: '1Z999AA10123456784' });
    const marcus = await loginAs(MARCUS);
    const s = (await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions',
      { token: marcus.token })).body.items[0];
    expect(s.source).toBe('package');
    const r = await api<{ linked: number }>('POST', '/api/suppliers/adopt',
      { token: marcus.token, body: s });
    expect(r.body.linked).toBe(1);
  });

  it('refuses to adopt the same seller twice', async () => {
    await seedHistory(MARCUS, { order: 'PO-A020', seller: 'Twice Co', cost: 100 });
    const marcus = await loginAs(MARCUS);
    const s = (await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions',
      { token: marcus.token })).body.items[0];
    expect((await api('POST', '/api/suppliers/adopt', { token: marcus.token, body: s })).status).toBe(201);
    expect((await api('POST', '/api/suppliers/adopt', { token: marcus.token, body: s })).status).toBe(409);
  });

  it("files a manager's adoption under the purchaser who owns the orders", async () => {
    await seedHistory(PRIYA, { order: 'PO-A030', seller: 'Priyas Seller', cost: 2000 });
    const boss = await loginAs(ALEX);
    const s = (await api<{ items: Sugg[] }>('GET', '/api/suppliers/suggestions',
      { token: boss.token })).body.items.find((i) => i.name === 'Priyas Seller')!;
    const r = await api<{ id: string; linked: number }>('POST', '/api/suppliers/adopt',
      { token: boss.token, body: s });
    expect(r.body.linked).toBe(1);
    const priya = await loginAs(PRIYA);
    const mine = await api<{ items: { name: string }[] }>('GET', '/api/suppliers', { token: priya.token });
    expect(mine.body.items.map((i) => i.name)).toContain('Priyas Seller');
  });
});
