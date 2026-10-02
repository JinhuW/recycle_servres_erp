import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { createOAuthClient } from '../src/oauth/clients';
import { issueRefreshToken, rotateRefreshToken } from '../src/oauth/tokens';

// H1 regression: DELETE /api/members/:id blocks self-removal and removing the
// last active manager, but PATCH /api/members/:id (which accepts {active} and
// {role}) had NO such guards — a manager could deactivate themselves or the
// last manager and permanently lock everyone out.

const SOFIA = 'sofia@recycleservers.io'; // second seeded manager

type M = { id: string; email: string; role: string; active: boolean };

async function members(token: string): Promise<M[]> {
  const r = await api<{ items: M[] }>('GET', '/api/members?includeInactive=true', { token });
  return r.body.items;
}
const byEmail = (list: M[], email: string) => list.find(m => m.email === email)!;

describe('PATCH /api/members/:id — lockout guards', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects a manager deactivating themselves', async () => {
    const { token } = await loginAs(ALEX);
    const me = byEmail(await members(token), ALEX);

    const r = await api('PATCH', `/api/members/${me.id}`, { token, body: { active: false } });
    expect(r.status).toBe(400);

    const after = byEmail(await members(token), ALEX);
    expect(after.active).toBe(true);
  });

  it('rejects deactivating the last active manager', async () => {
    const { token } = await loginAs(ALEX);
    const sofia = byEmail(await members(token), SOFIA);
    // Soft-delete the other manager so ALEX is the only active manager left.
    expect((await api('DELETE', `/api/members/${sofia.id}`, { token })).status).toBe(200);

    const me = byEmail(await members(token), ALEX);
    const r = await api('PATCH', `/api/members/${me.id}`, { token, body: { active: false } });
    expect(r.status).toBe(400);
    expect(byEmail(await members(token), ALEX).active).toBe(true);
  });

  it('rejects demoting the last active manager to purchaser', async () => {
    const { token } = await loginAs(ALEX);
    const sofia = byEmail(await members(token), SOFIA);
    expect((await api('DELETE', `/api/members/${sofia.id}`, { token })).status).toBe(200);

    const me = byEmail(await members(token), ALEX);
    const r = await api('PATCH', `/api/members/${me.id}`, { token, body: { role: 'purchaser' } });
    expect(r.status).toBe(400);
    expect(byEmail(await members(token), ALEX).role).toBe('manager');
  });

  it('still allows deactivating a non-last manager', async () => {
    const { token } = await loginAs(ALEX);
    const sofia = byEmail(await members(token), SOFIA);

    const r = await api('PATCH', `/api/members/${sofia.id}`, { token, body: { active: false } });
    expect(r.status).toBe(200);
    expect(byEmail(await members(token), SOFIA).active).toBe(false);
  });
});

describe('PATCH /api/members/:id — deactivation ends sessions', () => {
  beforeEach(async () => { await resetDb(); });

  it('revokes the member’s cookie refresh families and OAuth grants', async () => {
    const { token } = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);
    const db = getTestDb();
    const client = await createOAuthClient(db, {
      name: 'deactivate-test', redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code', 'refresh_token'], scopes: ['market:read'],
      createdBy: null, public: false,
    });
    const grant = await issueRefreshToken(db, testEnv, {
      clientId: client.clientId, userId: marcus.user.id, scopes: ['market:read'],
    });

    const r = await api('PATCH', `/api/members/${marcus.user.id}`, { token, body: { active: false } });
    expect(r.status).toBe(200);

    const live = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM refresh_tokens
      WHERE user_id = ${marcus.user.id} AND revoked_at IS NULL
    `;
    expect(live[0].n).toBe(0);
    // Revoked, not merely refused while inactive: reactivating must not bring
    // either grant back.
    await db`UPDATE users SET active = TRUE WHERE id = ${marcus.user.id}`;
    expect((await api('POST', '/api/auth/refresh', { cookies: { rt: marcus.cookies.rt } })).status)
      .toBe(401);
    expect((await rotateRefreshToken(db, testEnv, grant.raw, client.clientId)).ok).toBe(false);
  });
});
