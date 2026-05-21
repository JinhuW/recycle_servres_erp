import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('pagination on /api/orders', () => {
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

describe('pagination on /api/sell-orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('limit caps response and exposes a next cursor', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ rows: { id: string; createdAt: string }[]; items: unknown[]; nextCursor: string | null }>(
      'GET', '/api/sell-orders?limit=3', { token });
    expect(r.status).toBe(200);
    expect(r.body.rows.length).toBeLessThanOrEqual(3);
    expect(r.body.items.length).toBe(r.body.rows.length); // back-compat alias
    expect(r.body.nextCursor).toBeTruthy();
  });

  it('cursor returns the next page without overlap and in descending created_at', async () => {
    const { token } = await loginAs(ALEX);
    const a = await api<{ rows: { id: string; createdAt: string }[]; nextCursor: string | null }>(
      'GET', '/api/sell-orders?limit=3', { token });
    const b = await api<{ rows: { id: string; createdAt: string }[]; nextCursor: string | null }>(
      'GET', '/api/sell-orders?limit=3&cursor=' + encodeURIComponent(a.body.nextCursor!), { token });
    expect(b.status).toBe(200);
    const seen = new Set(a.body.rows.map(r => r.id));
    for (const r of b.body.rows) expect(seen.has(r.id)).toBe(false);
    // Page B's first row must be older than page A's last row (DESC order).
    const lastA = a.body.rows[a.body.rows.length - 1];
    const firstB = b.body.rows[0];
    expect(firstB.createdAt <= lastA.createdAt).toBe(true);
  });
});
