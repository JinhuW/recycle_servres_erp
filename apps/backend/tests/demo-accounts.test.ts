import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';

type Resp = { users: { email: string }[] };

describe('GET /api/auth/demo-accounts gating', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns 404 when ENABLE_DEMO_ACCOUNTS is unset (even in non-prod)', async () => {
    // NODE_ENV is unset in tests but ENABLE_DEMO_ACCOUNTS must also be set
    const r = await api<{ error: string }>('GET', '/api/auth/demo-accounts');
    expect(r.status).toBe(404);
  });

  it('returns 404 in production even with ENABLE_DEMO_ACCOUNTS=true', async () => {
    const r = await api<{ error: string }>('GET', '/api/auth/demo-accounts', {
      env: { NODE_ENV: 'production', ENABLE_DEMO_ACCOUNTS: 'true' },
    });
    expect(r.status).toBe(404);
  });

  it('returns 404 in production with no flag set', async () => {
    const r = await api<{ error: string }>('GET', '/api/auth/demo-accounts', {
      env: { NODE_ENV: 'production' },
    });
    expect(r.status).toBe(404);
  });

  it('returns users only when ENABLE_DEMO_ACCOUNTS=true AND NODE_ENV is not production', async () => {
    // NODE_ENV is unset in testEnv (=undefined), satisfying !== 'production'.
    // Only override ENABLE_DEMO_ACCOUNTS=true so both gate conditions hold.
    const r = await api<Resp>('GET', '/api/auth/demo-accounts', {
      env: { ENABLE_DEMO_ACCOUNTS: 'true' },
    });
    expect(r.status).toBe(200);
    expect(r.body.users.length).toBeGreaterThan(0);
  });

  it('returns 404 when ENABLE_DEMO_ACCOUNTS is false (production guard)', async () => {
    const r = await api<{ error: string }>('GET', '/api/auth/demo-accounts', {
      env: { NODE_ENV: 'development', ENABLE_DEMO_ACCOUNTS: 'false' },
    });
    expect(r.status).toBe(404);
  });
});
