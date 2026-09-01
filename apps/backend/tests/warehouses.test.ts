import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Wh = { id: string; short: string; active: boolean };

describe('Warehouse active/archive', () => {
  beforeEach(async () => { await resetDb(); });

  it('GET /api/warehouses exposes active=true for seeded warehouses', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: Wh[] }>('GET', '/api/warehouses', { token });
    expect(r.status).toBe(200);
    const hk = r.body.items.find(w => w.id === 'WH-HK');
    expect(hk).toBeDefined();
    expect(hk!.active).toBe(true);
  });

  it('manager PATCH { active:false } archives the warehouse and echoes active=false', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<Wh>('PATCH', '/api/warehouses/WH-HK', {
      token, body: { active: false },
    });
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(false);
  });

  it('archived warehouse is excluded from GET /api/warehouses', async () => {
    const { token } = await loginAs(ALEX);
    await api('PATCH', '/api/warehouses/WH-HK', { token, body: { active: false } });

    const r = await api<{ items: Wh[] }>('GET', '/api/warehouses', { token });
    expect(r.status).toBe(200);
    const ids = r.body.items.map(w => w.id);
    expect(ids).not.toContain('WH-HK');
    // A still-active seeded warehouse remains visible.
    expect(ids).toContain('WH-LA1');
  });

  it('purchaser cannot archive a warehouse (403) and it stays visible', async () => {
    const mgr = await loginAs(ALEX);
    const pur = await loginAs(MARCUS);

    const r = await api('PATCH', '/api/warehouses/WH-HK', {
      token: pur.token, body: { active: false },
    });
    expect(r.status).toBe(403);

    const list = await api<{ items: Wh[] }>('GET', '/api/warehouses', { token: mgr.token });
    expect(list.body.items.map(w => w.id)).toContain('WH-HK');
  });
});

type WhMgr = {
  id: string;
  manager: string | null;
  managerPhone: string | null;
  managerEmail: string | null;
  managerUserId: string | null;
};

describe('Warehouse manager linked to a DB user (manager_user_id FK)', () => {
  beforeEach(async () => { await resetDb(); });

  it('PATCH managerUserId links a user; GET derives manager contact from that user', async () => {
    const { token, user } = await loginAs(ALEX);

    const patch = await api('PATCH', '/api/warehouses/WH-HK', {
      token, body: { managerUserId: user.id },
    });
    expect(patch.status).toBe(200);

    const list = await api<{ items: WhMgr[] }>('GET', '/api/warehouses', { token });
    const hk = list.body.items.find(w => w.id === 'WH-HK');
    expect(hk).toBeDefined();
    expect(hk!.managerUserId).toBe(user.id);
    expect(hk!.managerEmail).toBe(user.email);
    expect(typeof hk!.manager).toBe('string');
    expect((hk!.manager ?? '').length).toBeGreaterThan(0);
  });

  it('POST accepts managerUserId and echoes derived manager fields', async () => {
    const { token, user } = await loginAs(ALEX);
    const r = await api<WhMgr>('POST', '/api/warehouses', {
      token,
      body: { id: 'WH-MGR', name: 'Mgr WH', short: 'MGR', region: 'US-East', managerUserId: user.id },
    });
    expect(r.status).toBe(201);
    expect(r.body.managerUserId).toBe(user.id);
    expect(r.body.managerEmail).toBe(user.email);
  });

  it('rejects an unknown managerUserId with 400', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/warehouses/WH-HK', {
      token, body: { managerUserId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.status).toBe(400);
  });

  it('rejects a malformed managerUserId with 400, not a 500', async () => {
    // The uuid cast raises 22P02, the one database error that really is the
    // caller's fault. The lookup narrowed its catch to that code — any other
    // fault (a dead pool) now surfaces as a 500 instead of masquerading as
    // "manager not found".
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/warehouses/WH-HK', {
      token, body: { managerUserId: 'not-a-uuid' },
    });
    expect(r.status).toBe(400);
  });
});

describe('Warehouse PII: purchasers cannot see manager email/phone', () => {
  beforeAll(async () => { await resetDb(); });

  it('manager sees managerEmail and managerPhone when a user is linked', async () => {
    const { token, user } = await loginAs(ALEX);
    await api('PATCH', '/api/warehouses/WH-HK', { token, body: { managerUserId: user.id } });

    const list = await api<{ items: WhMgr[] }>('GET', '/api/warehouses', { token });
    const hk = list.body.items.find(w => w.id === 'WH-HK')!;
    expect(hk.managerEmail).toBeTruthy();
  });

  it('purchaser sees null for managerEmail and managerPhone even when a user is linked', async () => {
    const mgr = await loginAs(ALEX);
    await api('PATCH', '/api/warehouses/WH-HK', {
      token: mgr.token, body: { managerUserId: mgr.user.id },
    });

    const { token } = await loginAs(MARCUS);
    const list = await api<{ items: WhMgr[] }>('GET', '/api/warehouses', { token });
    expect(list.status).toBe(200);
    const hk = list.body.items.find(w => w.id === 'WH-HK')!;
    expect(hk).toBeDefined();
    expect(hk.managerEmail).toBeNull();
    expect(hk.managerPhone).toBeNull();
    // name is still visible
    expect(typeof hk.manager).toBe('string');
  });
});

describe('Warehouse DELETE handles transfer_orders FK', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns 409 (not 500) when transfer_orders.to_warehouse_id points at it and no transferTo is given', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    await db`
      INSERT INTO transfer_orders (id, from_warehouse_id, to_warehouse_id, status)
      VALUES ('TO-FK-1', NULL, 'WH-DAL', 'Pending')
    `;

    const r = await api('DELETE', '/api/warehouses/WH-DAL', { token });
    expect(r.status).toBe(409);

    // Warehouse must still exist after a refused delete.
    const list = await api<{ items: Wh[] }>('GET', '/api/warehouses', { token });
    expect(list.body.items.find(w => w.id === 'WH-DAL')).toBeDefined();

    // Cleanup so the next test's resetDb path stays clean.
    await db`DELETE FROM transfer_orders WHERE id = 'TO-FK-1'`;
  });

  it('reassigns transfer_orders.to_warehouse_id when transferTo is supplied', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    await db`
      INSERT INTO transfer_orders (id, from_warehouse_id, to_warehouse_id, status)
      VALUES ('TO-FK-2', NULL, 'WH-DAL', 'Pending')
    `;

    const r = await api('DELETE', '/api/warehouses/WH-DAL?transferTo=WH-LA1', { token });
    expect(r.status).toBe(200);

    const rows = await db<{ to_warehouse_id: string }[]>`
      SELECT to_warehouse_id FROM transfer_orders WHERE id = 'TO-FK-2'
    `;
    expect(rows[0].to_warehouse_id).toBe('WH-LA1');
  });

  it('clears nullable transfer_orders.from_warehouse_id when transferTo is omitted', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    await db`
      INSERT INTO transfer_orders (id, from_warehouse_id, to_warehouse_id, status)
      VALUES ('TO-FK-3', 'WH-DAL', 'WH-LA1', 'Pending')
    `;

    const r = await api('DELETE', '/api/warehouses/WH-DAL', { token });
    expect(r.status).toBe(200);

    const rows = await db<{ from_warehouse_id: string | null }[]>`
      SELECT from_warehouse_id FROM transfer_orders WHERE id = 'TO-FK-3'
    `;
    expect(rows[0].from_warehouse_id).toBeNull();
  });
});

describe('Warehouse API no longer exposes cutoffLocal / sqft', () => {
  beforeEach(async () => { await resetDb(); });

  it('GET items omit cutoffLocal and sqft', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: Record<string, unknown>[] }>('GET', '/api/warehouses', { token });
    expect(list.status).toBe(200);
    const wh = list.body.items[0];
    expect(wh).toBeDefined();
    expect(wh).not.toHaveProperty('cutoffLocal');
    expect(wh).not.toHaveProperty('sqft');
  });

  it('POST ignores cutoffLocal/sqft and the response omits them', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<Record<string, unknown>>('POST', '/api/warehouses', {
      token,
      body: { id: 'WH-NOSQ', name: 'NoSq', short: 'NOSQ', region: 'US-East', cutoffLocal: '15:00', sqft: 1234 },
    });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('cutoffLocal');
    expect(created.body).not.toHaveProperty('sqft');
  });
});

// `address` is the display line on cards and pickers. It used to be a second,
// hand-typed copy of the ship-to that drifted from it; it is now derived from
// the structured columns, so the editor has one address field instead of two.
describe('Warehouse address is derived from the ship-to', () => {
  beforeEach(async () => { await resetDb(); });

  type WhAddr = {
    id: string; address: string | null;
    shipStreet1: string | null; shipCity: string | null;
  };

  const DENVER = {
    shipStreet1: '4880 Ironton St', shipStreet2: null,
    shipCity: 'Denver', shipState: 'CO', shipZip: '80239', shipCountry: 'US',
  };

  const readWh = async (token: string, id: string): Promise<WhAddr> => {
    const r = await api<{ items: WhAddr[] }>('GET', '/api/warehouses', { token });
    expect(r.status).toBe(200);
    return r.body.items.find(w => w.id === id)!;
  };

  it('PATCH of the ship fields composes address', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', { token, body: DENVER });
    expect(r.status).toBe(200);
    expect(r.body.address).toBe('4880 Ironton St, Denver, CO 80239');
    expect((await readWh(token, 'WH-LA1')).address).toBe('4880 Ironton St, Denver, CO 80239');
  });

  it('includes street line 2 when present', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', {
      token, body: { ...DENVER, shipStreet2: 'Suite 400' },
    });
    expect(r.body.address).toBe('4880 Ironton St, Suite 400, Denver, CO 80239');
  });

  it('appends a non-US country but never US', async () => {
    const { token } = await loginAs(ALEX);
    const nl = await api<WhAddr>('PATCH', '/api/warehouses/WH-AMS', {
      token,
      body: {
        shipStreet1: 'Schiphol Logistics Park', shipStreet2: null,
        shipCity: 'Amsterdam', shipState: null, shipZip: '1118 BE', shipCountry: 'nl',
      },
    });
    expect(nl.status).toBe(200);
    // No state: city and ZIP join with a space, not a stray comma.
    expect(nl.body.address).toBe('Schiphol Logistics Park, Amsterdam 1118 BE, NL');

    const us = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', { token, body: DENVER });
    expect(us.body.address).not.toMatch(/US$/);
  });

  it('treats a null country as US', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', {
      token, body: { ...DENVER, shipCountry: null },
    });
    expect(r.body.address).toBe('4880 Ironton St, Denver, CO 80239');
  });

  it('clearing the ship fields clears address', async () => {
    const { token } = await loginAs(ALEX);
    await api('PATCH', '/api/warehouses/WH-LA1', { token, body: DENVER });
    const cleared = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', {
      token,
      body: {
        shipStreet1: null, shipStreet2: null, shipCity: null,
        shipState: null, shipZip: null, shipCountry: null,
      },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.address).toBeNull();
  });

  // The archive toggle PATCHes { active } alone; it must not touch the address.
  it('a PATCH that does not name an address part leaves address alone', async () => {
    const { token } = await loginAs(ALEX);
    await api('PATCH', '/api/warehouses/WH-LA1', { token, body: DENVER });
    const renamed = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', {
      token, body: { name: 'LA One' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.address).toBe('4880 Ironton St, Denver, CO 80239');
  });

  it('POST derives address from the ship fields it was created with', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<WhAddr>('POST', '/api/warehouses', {
      token,
      body: { id: 'WH-DEN', name: 'Denver', short: 'DEN', region: 'US-West', ...DENVER },
    });
    expect(created.status).toBe(201);
    expect(created.body.address).toBe('4880 Ironton St, Denver, CO 80239');
  });

  // Warehouses that predate the ship-to columns have only their free text, and
  // it cannot be parsed back into street/city/state/ZIP. Migration 0109 skips
  // them and so must every write that doesn't name an address part.
  it('leaves a warehouse with no ship-to holding its original free text', async () => {
    const { token } = await loginAs(ALEX);
    const before = await readWh(token, 'WH-HK');
    expect(before.shipStreet1).toBeNull();
    expect(before.address).toBeTruthy();

    const r = await api<WhAddr>('PATCH', '/api/warehouses/WH-HK', {
      token, body: { name: 'Hong Kong' },
    });
    expect(r.status).toBe(200);
    expect(r.body.address).toBe(before.address);
  });

  it('prefers the derived line over a client-sent address', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', {
      token, body: { ...DENVER, address: 'typed by hand' },
    });
    expect(r.body.address).toBe('4880 Ironton St, Denver, CO 80239');
  });

  // A client that predates the derivation sends its free-text `address`
  // alongside all six ship fields on every save, so it always counts as
  // touching the address. Dropping that text outright recomputed a warehouse
  // that only ever had free text down to NULL — a stale tab saving anything at
  // all was enough to erase the only address it had.
  it('keeps a legacy free-text address when the ship-to composes nothing', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<WhAddr>('PATCH', '/api/warehouses/WH-LA1', {
      token,
      body: {
        address: 'Unit 7, Kwai Chung', shipStreet1: null, shipStreet2: null,
        shipCity: null, shipState: null, shipZip: null, shipCountry: null,
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.address).toBe('Unit 7, Kwai Chung');
    expect((await readWh(token, 'WH-LA1')).address).toBe('Unit 7, Kwai Chung');
  });

  it('POST keeps a legacy address when it was created with no ship-to', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<WhAddr>('POST', '/api/warehouses', {
      token,
      body: {
        id: 'WH-LEG', name: 'Legacy', short: 'LEG', region: 'APAC',
        address: 'Unit 7, Kwai Chung',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.address).toBe('Unit 7, Kwai Chung');
  });
});
