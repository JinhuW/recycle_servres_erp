import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// SKIPPED (reconciliation Step 6.3): cursor pagination on /api/orders
// (parallel commit 9099b6b) is deferred — wiring lib/pagination.ts into the
// shared orders route would change main's response shape that the frontend
// depends on. The lib + supporting indexes (0017) ARE ported.
describe.skip('pagination on /api/orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('limit caps response size', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ orders: unknown[]; nextCursor: string | null }>(
      'GET', '/api/orders?limit=3', { token });
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeLessThanOrEqual(3);
    expect(r.body.nextCursor).toBeTruthy();
  });

  it('cursor returns next page without overlap', async () => {
    const { token } = await loginAs(ALEX);
    const a = await api<{ orders: { id: string }[]; nextCursor: string | null }>(
      'GET', '/api/orders?limit=3', { token });
    const b = await api<{ orders: { id: string }[]; nextCursor: string | null }>(
      'GET', '/api/orders?limit=3&cursor=' + encodeURIComponent(a.body.nextCursor!), { token });
    expect(b.status).toBe(200);
    const ids = new Set(a.body.orders.map(o => o.id));
    for (const o of b.body.orders) expect(ids.has(o.id)).toBe(false);
  });

  it('rejects unknown sort column', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/orders?sort=password_hash:asc', { token });
    expect(r.status).toBe(400);
  });
});
