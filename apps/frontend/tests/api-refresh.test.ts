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

  it('a 401 from login is bad credentials, not an expired session', async () => {
    const calls: string[] = [];
    let unauthorized = 0;
    const onUnauthorized = () => { unauthorized++; };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response('{"error":"Invalid credentials"}', { status: 401 });
    }) as any;
    const { api, ApiError } = await import('../src/lib/api');
    await expect(api.post('/api/auth/login', { email: 'a@b.c', password: 'wrong' }))
      .rejects.toBeInstanceOf(ApiError);
    window.removeEventListener('auth:unauthorized', onUnauthorized);
    expect(calls.filter(c => c === 'POST /api/auth/refresh').length).toBe(0);
    expect(calls.filter(c => c === 'POST /api/auth/login').length).toBe(1);
    expect(unauthorized).toBe(0);
  });

  it('every request sends credentials + X-Requested-By', async () => {
    let seen: any = null;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => { seen = init; return new Response('{}', { status: 200 }); }) as any;
    const { api } = await import('../src/lib/api');
    await api.get('/api/me');
    expect(seen.credentials).toBe('include');
    expect(new Headers(seen.headers).get('X-Requested-By')).toBe('recycle-erp');
  });

  // Two tabs whose cookie expired together used to both refresh; the second
  // presented the rotated-out token and revoked the whole family.
  describe('across tabs', () => {
    const store = new Map<string, string>();
    beforeEach(() => {
      store.clear();
      (globalThis as any).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      };
    });

    it('takes the refresh under a Web Lock', async () => {
      const names: string[] = [];
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { locks: { request: async (name: string, cb: () => Promise<unknown>) => { names.push(name); return cb(); } } },
      });
      let orders = 0;
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u === '/api/orders') { orders++; return new Response('{}', { status: orders === 1 ? 401 : 200 }); }
        return new Response('{}', { status: 200 });
      }) as any;
      const { api } = await import('../src/lib/api');
      await api.get('/api/orders');
      expect(names).toEqual(['erp-auth-refresh']);
      expect(Number(store.get('erp.auth.refreshedAt'))).toBeGreaterThan(0);
    });

    it('reuses a refresh another tab made after this request went out', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        // The lock is granted only once the other tab's refresh has landed.
        value: { locks: { request: async (_n: string, cb: () => Promise<unknown>) => {
          store.set('erp.auth.refreshedAt', String(Date.now() + 1000));
          return cb();
        } } },
      });
      const calls: string[] = [];
      let orders = 0;
      globalThis.fetch = vi.fn(async (url: any, init: any) => {
        const u = String(url);
        calls.push(`${init?.method ?? 'GET'} ${u}`);
        if (u === '/api/orders') { orders++; return new Response('{}', { status: orders === 1 ? 401 : 200 }); }
        return new Response('{}', { status: 200 });
      }) as any;
      let established = 0;
      const onEstablished = () => { established++; };
      window.addEventListener('auth:established', onEstablished);
      const { api } = await import('../src/lib/api');
      await api.get('/api/orders');
      window.removeEventListener('auth:established', onEstablished);
      expect(established).toBe(1);
      expect(calls.filter((c) => c === 'POST /api/auth/refresh')).toHaveLength(0);
      expect(calls.filter((c) => c === 'GET /api/orders')).toHaveLength(2);
    });
  });
});
