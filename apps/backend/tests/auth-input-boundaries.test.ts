import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { ALEX } from './helpers/auth';

describe('POST /api/auth/login input types', () => {
  beforeAll(async () => { await resetDb(); });

  const login = (body: unknown) => api<{ error?: string }>('POST', '/api/auth/login', { body });

  it('400s, not 500s, on a non-string email', async () => {
    const r = await login({ email: ['alex@recycleservers.io'], password: 'demo' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/email and password required/);
  });

  it('400s on a non-string password', async () => {
    expect((await login({ email: ALEX, password: { $gt: '' } })).status).toBe(400);
    expect((await login({ email: ALEX, password: 12345678 })).status).toBe(400);
  });

  it('400s on a body that is not an object', async () => {
    expect((await login('alex')).status).toBe(400);
    expect((await login(null)).status).toBe(400);
  });

  it('still signs in with string credentials', async () => {
    expect((await login({ email: ALEX, password: 'demo' })).status).toBe(200);
  });
});

describe('X-Proxy-Secret origin gate', () => {
  const SECRET = 's'.repeat(64); // pragma: allowlist secret
  const env = { PROXY_SECRET: SECRET };

  it('refuses a request without the header', async () => {
    const r = await api('GET', '/api/auth/demo-accounts', { env });
    expect(r.status).toBe(403);
  });

  it('refuses a wrong secret of the same length and of a different length', async () => {
    for (const given of ['t'.repeat(64), 's'.repeat(63), `${SECRET}s`]) {
      const r = await api('GET', '/api/auth/demo-accounts', { env, headers: { 'X-Proxy-Secret': given } });
      expect(r.status, given.length.toString()).toBe(403);
    }
  });

  it('lets the right secret through', async () => {
    const r = await api('GET', '/api/auth/demo-accounts', { env, headers: { 'X-Proxy-Secret': SECRET } });
    expect(r.status).not.toBe(403);
  });

  it('exempts /api/health', async () => {
    const r = await api('GET', '/api/health', { env });
    expect(r.status).not.toBe(403);
  });
});
