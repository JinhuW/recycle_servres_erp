import { describe, it, expect, vi, beforeEach } from 'vitest';

// This repo's vitest runs in the default `node` environment (no jsdom). Provide
// the same window/localStorage shims the other auth tests use so the auth
// module and these listeners behave exactly as in a browser.
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = new EventTarget();
}
if (!(globalThis as any).localStorage) (globalThis as any).localStorage = {
  _s: new Map<string,string>(),
  getItem(k: string){ return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k: string,v: string){ this._s.set(k,String(v)); },
  removeItem(k: string){ this._s.delete(k); }, clear(){ this._s.clear(); },
};

// The auth:unauthorized listener calls handleUnauthorized(user, logout, setUser)
// with the live user. We exercise that exported decision helper directly so the
// test stays in this repo's renderer-free node pattern while covering the exact
// logic the listener runs.
describe('auth:unauthorized only POSTs logout when a session exists', () => {
  beforeEach(() => vi.resetModules());

  it('no current user -> no POST /api/auth/logout (local state still cleared)', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response('{}', { status: 200 });
    }) as any;

    const { handleUnauthorized } = await import('../src/lib/auth');

    const logout = vi.fn(async () => { await import('../src/lib/api').then(m => m.api.post('/api/auth/logout', {})); });
    const setUser = vi.fn();

    handleUnauthorized(null, logout, setUser);
    await Promise.resolve();
    await Promise.resolve();

    expect(logout).not.toHaveBeenCalled();
    expect(calls.filter(c => c === 'POST /api/auth/logout').length).toBe(0);
    // local state still cleared
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it('current user present -> POST /api/auth/logout DOES happen', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response('{}', { status: 200 });
    }) as any;

    const { handleUnauthorized } = await import('../src/lib/auth');
    const { api } = await import('../src/lib/api');

    // Real logout path hits the server then clears local state.
    const setUser = vi.fn();
    const logout = async () => { await api.post('/api/auth/logout', {}).catch(() => {}); };

    handleUnauthorized({ id: 'u1', email: 'a@b.c', role: 'admin', language: 'en' } as any, logout, setUser);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.filter(c => c === 'POST /api/auth/logout').length).toBeGreaterThan(0);
  });
});
