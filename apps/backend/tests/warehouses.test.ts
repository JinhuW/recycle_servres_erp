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
