import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

type M = { id: string; email: string; last_seen_at: string | null };

describe('GET /api/members — last_seen_at', () => {
  beforeEach(async () => { await resetDb(); });

  it('is null until a member signs in, then set after login', async () => {
    // ALEX logs in (loginAs performs the login round-trip).
    const { token } = await loginAs(ALEX);

    const r = await api<{ items: M[] }>('GET', '/api/members?includeInactive=true', { token });
    expect(r.status).toBe(200);

    const alex = r.body.items.find(m => m.email === ALEX)!;
    expect(alex.last_seen_at).not.toBeNull();

    // MARCUS has never logged in this run → still null.
    const marcus = r.body.items.find(m => m.email === MARCUS)!;
    expect(marcus.last_seen_at).toBeNull();
  });
});

describe('deactivated members cannot authenticate', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses fresh login and rejects a token issued before soft-delete', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: priyaToken } = await loginAs(PRIYA);

    const list = await api<{ items: { id: string; email: string }[] }>(
      'GET', '/api/members?includeInactive=true', { token: mgr });
    const priya = list.body.items.find(m => m.email === PRIYA)!;

    const del = await api('DELETE', `/api/members/${priya.id}`, { token: mgr });
    expect(del.status).toBe(200);

    // 1. A fresh login attempt is refused.
    const relogin = await api('POST', '/api/auth/login', { body: { email: PRIYA, password: 'demo' } });
    expect(relogin.status).toBe(401);

    // 2. The token minted before deactivation no longer works.
    const me = await api('GET', '/api/me', { token: priyaToken });
    expect(me.status).toBe(401);
  });
});
