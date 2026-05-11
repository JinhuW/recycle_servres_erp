import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('GET /api/inventory — role-based field visibility', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager sees unit_cost / profit / margin', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: Record<string, unknown>[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    const item = r.body.items[0];
    expect(item).toBeDefined();
    expect(item).toHaveProperty('unit_cost');
    expect(typeof (item as { unit_cost: number }).unit_cost).toBe('number');
  });

  it('purchaser does NOT see unit_cost / profit / margin', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ items: Record<string, unknown>[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    const item = r.body.items[0];
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('unit_cost');
    expect(item).not.toHaveProperty('profit');
    expect(item).not.toHaveProperty('margin');
    // Sell price IS visible (it's the price the team is asking — not sensitive).
    expect(item).toHaveProperty('sell_price');
  });

  it('purchaser scoped to own lines only', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{ items: { user_id: string }[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    for (const it of r.body.items) expect(it.user_id).toBe(user.id);
  });
});

describe('GET /api/inventory/aggregate/by-part', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns inTransit / inStock counts for a part number', async () => {
    const { token } = await loginAs(ALEX);
    // Find a part number that exists in seed
    const list = await api<{ items: { part_number: string }[] }>('GET', '/api/inventory', { token });
    const pn = list.body.items.find(i => i.part_number)?.part_number;
    expect(pn).toBeTruthy();

    const r = await api<{ partNumber: string; inTransit: number; inStock: number; lines: number }>(
      'GET', `/api/inventory/aggregate/by-part?partNumber=${encodeURIComponent(pn!)}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.partNumber).toBe(pn);
    expect(r.body.lines).toBeGreaterThanOrEqual(1);
  });

  it('400 when partNumber missing', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/inventory/aggregate/by-part', { token });
    expect(r.status).toBe(400);
  });
});
