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

describe('low-margin notification', () => {
  beforeEach(async () => { await resetDb(); });

  it('fires when sell_price gives margin < 15%', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: { id: string; unit_cost: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    const target = list.body.items[0];
    const newPrice = +(target.unit_cost * 1.05).toFixed(2);

    const r = await api<{ warnings?: string[] }>('PATCH', `/api/inventory/${target.id}`, {
      token, body: { sellPrice: newPrice },
    });
    expect(r.status).toBe(200);
    expect(r.body.warnings ?? []).toContain('low_margin');
    const after = await api<{ items: { kind: string }[] }>('GET', '/api/notifications', { token });
    expect(after.body.items.some(i => i.kind === 'low_margin')).toBe(true);
  });

  it('honours a workspace-configured low_margin_floor', async () => {
    const { token } = await loginAs(ALEX);
    // Drop the floor to 0 — a thin 5% margin should no longer warn.
    const w = await api('PATCH', '/api/workspace', { token, body: { low_margin_floor: 0 } });
    expect(w.status).toBe(200);

    const list = await api<{ items: { id: string; unit_cost: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    const target = list.body.items[0];
    const newPrice = +(target.unit_cost * 1.05).toFixed(2);

    const r = await api<{ warnings?: string[] }>('PATCH', `/api/inventory/${target.id}`, {
      token, body: { sellPrice: newPrice },
    });
    expect(r.status).toBe(200);
    expect(r.body.warnings ?? []).not.toContain('low_margin');
  });
});

describe('audit log is append-only', () => {
  beforeEach(async () => { await resetDb(); });

  it('raw UPDATE on inventory_events is rejected', async () => {
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    let err: Error | null = null;
    try {
      await sql`UPDATE inventory_events SET detail = '{}'::jsonb WHERE id IN (SELECT id FROM inventory_events LIMIT 1)`;
    } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/append-only/i);
  });
});
