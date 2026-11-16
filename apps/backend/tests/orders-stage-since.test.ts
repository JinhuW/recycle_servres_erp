import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

type Row = { id: string; createdAt: string; stageSince: string };

describe('GET /api/orders stageSince', () => {
  beforeEach(async () => { await resetDb(); });

  it('is the newest stage move, else when the PO was created', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    const [moved] = await db<{ id: string }[]>`SELECT id FROM orders ORDER BY id LIMIT 1`;
    const at = '2026-11-10T09:30:00.000Z';
    await db`
      INSERT INTO order_events (order_id, kind, detail, created_at)
      VALUES (${moved.id}, 'advanced', ${db.json({ from: 'in_transit', to: 'reviewing' })}, ${at})
    `;
    const r = await api<{ orders: Row[] }>('GET', '/api/orders?limit=200&includeArchived=true', { token });
    expect(r.status).toBe(200);
    const byId = new Map(r.body.orders.map(o => [o.id, o]));
    expect(new Date(byId.get(moved.id)!.stageSince).toISOString()).toBe(at);

    const [never] = await db<{ id: string }[]>`
      SELECT o.id FROM orders o
      WHERE NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind IN ('submitted', 'advanced', 'reverted'))
      LIMIT 1
    `;
    if (never && byId.has(never.id)) {
      const row = byId.get(never.id)!;
      expect(new Date(row.stageSince).getTime()).toBe(new Date(row.createdAt).getTime());
    }
  });
});
