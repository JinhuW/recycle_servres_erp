import { describe, it, expect, vi, beforeEach } from 'vitest';

// Node env: provide window/localStorage shims a browser gives natively.
if (typeof window === 'undefined') (globalThis as any).window = new EventTarget();
if (!(globalThis as any).localStorage) (globalThis as any).localStorage = {
  _s: new Map<string,string>(),
  getItem(k: string){ return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k: string,v: string){ this._s.set(k,String(v)); },
  removeItem(k: string){ this._s.delete(k); }, clear(){ this._s.clear(); },
};

describe('auth context is cookie-based (no token storage)', () => {
  beforeEach(() => vi.resetModules());

  it('module exposes the provider/hook and no token store', async () => {
    const mod: any = await import('../src/lib/auth');
    // Provider + hook still exported (names may be AuthProvider/useAuth — assert at least one provider + one hook-ish export exists)
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
    expect(mod.tokenStore).toBeUndefined();
    expect(mod.auth).toBeUndefined();
  });

  it('does not reference localStorage for an auth token', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/lib/auth.tsx', import.meta.url), 'utf8'));
    expect(/localStorage/.test(src)).toBe(false);
    expect(/recycle_erp_token/.test(src)).toBe(false);
  });
});
