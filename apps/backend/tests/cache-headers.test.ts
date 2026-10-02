import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Regression: /api/warehouses used to carry `private, max-age=60`. Settings
// saves a warehouse, immediately re-reads the list, and the browser answered
// from its own 60s-old copy — so a shipping address that had genuinely been
// written looked like it had never saved. Reference data that is only read
// keeps the cache; anything edited in-session must not.
describe('Cache-Control on reference-data endpoints', () => {
  beforeEach(async () => { await resetDb(); });

  it('does NOT cache /api/warehouses', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/warehouses', { token });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBeNull();
  });

  // Under the cached /api/workspace prefix, but re-read right after a save.
  it('does NOT cache /api/workspace/fx-rates', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/workspace/fx-rates', { token });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBeNull();
  });

  it('still caches the rest of /api/workspace', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/workspace', { token });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('still caches /api/lookups', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/lookups', { token });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, max-age=60');
  });

  // The prefixes that stay cached also serve mutations; only safe methods may
  // advertise a lifetime.
  it('does not cache a PATCH under a cached prefix', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/workspace', {
      token, body: { upload_max_bytes: 5_000_000 },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBeNull();
  });
});
