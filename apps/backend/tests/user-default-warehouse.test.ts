import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const LINES = {
  lines: [{ category: 'HDD', qty: 1, unitCost: 10, condition: 'New' }],
};

type MeUser = { user: { id: string; defaultWarehouseId: string | null } };

describe('users.default_warehouse_id', () => {
  beforeEach(async () => { await resetDb(); });

  it('is settable and clearable via PATCH /api/me and read back from GET /api/me', async () => {
    const marcus = await loginAs(MARCUS);
    expect((await api<MeUser>('GET', '/api/me', { token: marcus.token }))
      .body.user.defaultWarehouseId).toBeNull();

    const set = await api('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: 'WH-DAL' },
    });
    expect(set.status).toBe(200);
    expect((await api<MeUser>('GET', '/api/me', { token: marcus.token }))
      .body.user.defaultWarehouseId).toBe('WH-DAL');

    const clear = await api('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: null },
    });
    expect(clear.status).toBe(200);
    expect((await api<MeUser>('GET', '/api/me', { token: marcus.token }))
      .body.user.defaultWarehouseId).toBeNull();
  });

  it('rejects an unknown warehouse id', async () => {
    const marcus = await loginAs(MARCUS);
    const r = await api<{ error: string }>('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: 'WH-NOPE' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/warehouse/i);
  });

  it('defaults a new order to the creator’s home warehouse when none is sent', async () => {
    const marcus = await loginAs(MARCUS);
    await api('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: 'WH-NJ2' },
    });

    const r = await api<{ id: string }>('POST', '/api/orders', {
      token: marcus.token, body: LINES,
    });
    expect(r.status).toBe(201);
    const got = await api<{ order: { warehouse: { id: string } | null } }>(
      'GET', '/api/orders/' + r.body.id, { token: marcus.token },
    );
    expect(got.body.order.warehouse?.id).toBe('WH-NJ2');
  });

  it('an explicitly sent warehouse wins over the home warehouse', async () => {
    const marcus = await loginAs(MARCUS);
    await api('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: 'WH-NJ2' },
    });

    const r = await api<{ id: string }>('POST', '/api/orders', {
      token: marcus.token, body: { ...LINES, warehouseId: 'WH-LA1' },
    });
    expect(r.status).toBe(201);
    const got = await api<{ order: { warehouse: { id: string } | null } }>(
      'GET', '/api/orders/' + r.body.id, { token: marcus.token },
    );
    expect(got.body.order.warehouse?.id).toBe('WH-LA1');
  });

  it('an on-behalf order defaults to the purchaser’s home warehouse, not the manager’s', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);
    await api('PATCH', '/api/me', {
      token: alex.token, body: { defaultWarehouseId: 'WH-LA1' },
    });
    await api('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: 'WH-HK' },
    });

    const r = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES, onBehalfOfUserId: marcus.user.id },
    });
    expect(r.status).toBe(201);
    const got = await api<{ order: { warehouse: { id: string } | null } }>(
      'GET', '/api/orders/' + r.body.id, { token: alex.token },
    );
    expect(got.body.order.warehouse?.id).toBe('WH-HK');
  });

  it('an empty draft also picks up the owner’s home warehouse', async () => {
    const marcus = await loginAs(MARCUS);
    await api('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: 'WH-AMS' },
    });

    const r = await api<{ id: string }>('POST', '/api/orders/draft', {
      token: marcus.token, body: {},
    });
    expect(r.status).toBe(201);
    const got = await api<{ order: { warehouse: { id: string } | null } }>(
      'GET', '/api/orders/' + r.body.id, { token: marcus.token },
    );
    expect(got.body.order.warehouse?.id).toBe('WH-AMS');
  });

  it('login returns the default warehouse on the user object', async () => {
    const marcus = await loginAs(MARCUS);
    await api('PATCH', '/api/me', {
      token: marcus.token, body: { defaultWarehouseId: 'WH-DAL' },
    });
    const again = await loginAs(MARCUS);
    expect((again.user as { defaultWarehouseId?: string | null }).defaultWarehouseId).toBe('WH-DAL');
  });
});
