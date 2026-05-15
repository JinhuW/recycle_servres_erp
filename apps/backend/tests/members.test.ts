import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

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
