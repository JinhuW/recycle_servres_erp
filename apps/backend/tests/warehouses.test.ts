import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
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
