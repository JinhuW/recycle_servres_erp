import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

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
