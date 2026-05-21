import { describe, it, expect, vi, beforeEach } from 'vitest';

// This repo's vitest runs in the default `node` environment (no jsdom/happy-dom
// is installed and global test config is out of scope for this task). Provide a
// minimal `window` backed by Node's built-in EventTarget so the api client's
// `auth:unauthorized` dispatch and these tests' listeners behave exactly as in
// a browser, where `window` already exists and this shim is a no-op.
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = new EventTarget();
}

describe('api silent refresh', () => {
  beforeEach(() => vi.resetModules());

  it('refreshes once on 401 then retries the original request', async () => {
    const calls: string[] = [];
    let orders = 0;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url); const m = init?.method ?? 'GET';
      calls.push(`${m} ${u}`);
      if (u === '/api/orders') { orders++; return new Response('{"ok":true}', { status: orders === 1 ? 401 : 200 }); }
      if (u === '/api/auth/refresh') return new Response('{"ok":true}', { status: 200 });
      return new Response('{"ok":true}', { status: 200 });
    }) as any;
    const { api } = await import('../src/lib/api');
    const r = await api.get('/api/orders');
    expect(r).toBeTruthy();
    expect(calls.filter(c => c === 'POST /api/auth/refresh').length).toBe(1);
    expect(calls.filter(c => c === 'GET /api/orders').length).toBe(2);
  });

  it('a failed refresh dispatches auth:unauthorized and does not loop', async () => {
    let unauthorized = 0;
    window.addEventListener('auth:unauthorized', () => { unauthorized++; });
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u === '/api/auth/refresh') return new Response('{}', { status: 401 });
      return new Response('{}', { status: 401 });
    }) as any;
    const { api, ApiError } = await import('../src/lib/api');
    await expect(api.get('/api/orders')).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toBeGreaterThanOrEqual(1);
  });

  it('every request sends credentials + X-Requested-By', async () => {
    let seen: any = null;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => { seen = init; return new Response('{}', { status: 200 }); }) as any;
    const { api } = await import('../src/lib/api');
    await api.get('/api/me');
    expect(seen.credentials).toBe('include');
    expect(new Headers(seen.headers).get('X-Requested-By')).toBe('recycle-erp');
  });
});
