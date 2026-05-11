import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('/api/categories', () => {
  beforeEach(async () => { await resetDb(); });

  it('GET — both roles can list', async () => {
    for (const email of [ALEX, MARCUS]) {
      const { token } = await loginAs(email);
      const r = await api<{ items: { id: string; enabled: boolean }[] }>(
        'GET', '/api/categories', { token });
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeGreaterThanOrEqual(5);
      const ram = r.body.items.find(i => i.id === 'RAM');
      expect(ram?.enabled).toBe(true);
    }
  });

  it('PATCH — manager can toggle enabled', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/categories/CPU', { token, body: { enabled: true } });
    expect(r.status).toBe(200);
    const got = await api<{ items: { id: string; enabled: boolean }[] }>(
      'GET', '/api/categories', { token });
    expect(got.body.items.find(i => i.id === 'CPU')?.enabled).toBe(true);
  });

  it('PATCH — purchaser is forbidden', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('PATCH', '/api/categories/RAM', { token, body: { enabled: false } });
    expect(r.status).toBe(403);
  });

  it('POST — manager can add', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ id: string }>('POST', '/api/categories', {
      token, body: { id: 'NIC', label: 'NIC', icon: 'box', defaultMargin: 32 },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe('NIC');
  });
});

describe('POST /api/orders — category must be enabled', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects disabled category', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/orders', {
      token, body: {
        category: 'CPU',
        lines: [{ category: 'CPU', qty: 1, unitCost: 50, condition: 'New', description: 'Xeon' }],
      },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/disabled|not enabled/i);
  });
});
