import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS, PRIYA, SOFIA } from './helpers/auth';

type PrefsBody = { user: { preferences: Record<string, unknown> } };

// The frontend's PrefMap and this allowlist have to stay in step: a key the
// SPA writes but the server doesn't know 400s the whole batch, and the
// optimistic value is rolled back — so the preference silently never sticks.
describe('PATCH /api/me/preferences allowlist', () => {
  beforeEach(async () => { await resetDb(); });

  it('accepts every key the SPA writes, in one batch', async () => {
    const { token } = await loginAs(MARCUS);
    const res = await api<PrefsBody>('PATCH', '/api/me/preferences', {
      token,
      body: {
        'language': 'en',
        'tweaks.density': 'compact',
        'tweaks.rolePreview': 'actual',
        'inventory.cols.manager': ['partNumber'],
        'inventory.cols.purchaser': ['partNumber'],
        'analysis.collapsed': ['ram'],
        'orders.cols': ['id'],
        'market.showStaleOnly': true,
        'submit.lastCategory': 'SSD',
        'scan.deskCamera': true,
        'scan.cameraLabel': "Jinhu's iPhone Camera",
        'sellOrders.lineGroup': 'po',
        'sidebar.folded': true,
        'onboarding.done': true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.user.preferences['submit.lastCategory']).toBe('SSD');
  });

  it('rejects an unknown key and an over-long category', async () => {
    const { token } = await loginAs(MARCUS);
    const unknown = await api('PATCH', '/api/me/preferences', {
      token, body: { 'submit.lastCategoryy': 'SSD' },
    });
    expect(unknown.status).toBe(400);

    const tooLong = await api('PATCH', '/api/me/preferences', {
      token, body: { 'submit.lastCategory': 'x'.repeat(65) },
    });
    expect(tooLong.status).toBe(400);

    const badGroup = await api('PATCH', '/api/me/preferences', {
      token, body: { 'sellOrders.lineGroup': 'customer' },
    });
    expect(badGroup.status).toBe(400);
  });

  // `SCHEMA[key]` on a plain object found Object.prototype members: `toString`
  // and `constructor` were accepted as validators and the key persisted, and
  // `__proto__` reached a non-callable and 500ed.
  it('rejects inherited object keys like any unknown key', async () => {
    const { token } = await loginAs(MARCUS);
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const res = await api<{ error: string }>('PATCH', '/api/me/preferences', {
        token, body: JSON.parse(`{"${key}": "unknown"}`),
      });
      expect(res.status, key).toBe(400);
      expect(res.body.error).toContain('unknown preference');
    }
    const me = await api<PrefsBody>('GET', '/api/me', { token });
    expect(Object.keys(me.body.user.preferences)).not.toContain('toString');
  });
});

describe('PATCH /api/me/preferences merges against the live row', () => {
  beforeEach(async () => { await resetDb(); });

  // Each PATCH used to write back the whole document it loaded at request
  // start, so two tabs saving different keys kept only the later one's.
  it('keeps both keys when two patches land together', async () => {
    const { token } = await loginAs(MARCUS);
    const [a, b] = await Promise.all([
      api<PrefsBody>('PATCH', '/api/me/preferences', { token, body: { 'sidebar.folded': true } }),
      api<PrefsBody>('PATCH', '/api/me/preferences', { token, body: { 'market.showStaleOnly': true } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const me = await api<PrefsBody>('GET', '/api/me', { token });
    expect(me.body.user.preferences['sidebar.folded']).toBe(true);
    expect(me.body.user.preferences['market.showStaleOnly']).toBe(true);
  });

  it('null unsets a key and leaves the rest', async () => {
    const { token } = await loginAs(MARCUS);
    await api('PATCH', '/api/me/preferences', { token, body: { 'sidebar.folded': true, 'orders.cols': ['id'] } });
    const res = await api<PrefsBody>('PATCH', '/api/me/preferences', { token, body: { 'sidebar.folded': null } });
    expect(res.status).toBe(200);
    expect(res.body.user.preferences['sidebar.folded']).toBeUndefined();
    expect(res.body.user.preferences['orders.cols']).toEqual(['id']);
  });

  it('an unrelated patch does not touch the language column', async () => {
    const { token, user } = await loginAs(MARCUS);
    await getTestDb()`UPDATE users SET language = 'zh' WHERE id = ${user.id}`;
    const res = await api<{ user: { language: string } }>('PATCH', '/api/me/preferences', {
      token, body: { 'sidebar.folded': true },
    });
    expect(res.body.user.language).toBe('zh');
  });
});

// The walkthrough opens for whoever lacks the flag, so the release must not
// greet every existing purchaser with it — only members who never signed in.
describe('migration 0186 marks existing users as onboarded', () => {
  beforeEach(async () => { await resetDb(); });

  const replay = async () => {
    const sqlText = readFileSync(
      fileURLToPath(new URL('../migrations/0186_onboarding_done_for_existing_users.sql', import.meta.url)), 'utf8');
    await getTestDb().unsafe(sqlText);
  };
  const prefsOf = async (email: string) => {
    const [row] = await getTestDb()<{ preferences: Record<string, unknown> }[]>`
      SELECT preferences FROM users WHERE email = ${email}`;
    return row.preferences;
  };

  it('sets the flag for signed-in users and leaves pending invites without it', async () => {
    const db = getTestDb();
    await db`UPDATE users SET last_seen_at = NULL`;
    await db`UPDATE users SET last_seen_at = NOW(), preferences = '{"sidebar.folded": true}'::jsonb WHERE email = ${MARCUS}`;
    // An explicit choice already on the row is kept.
    await db`UPDATE users SET last_seen_at = NOW(), preferences = '{"onboarding.done": false}'::jsonb WHERE email = ${SOFIA}`;
    await replay();

    expect(await prefsOf(MARCUS)).toEqual({ 'sidebar.folded': true, 'onboarding.done': true });
    expect(await prefsOf(SOFIA)).toEqual({ 'onboarding.done': false });
    expect(await prefsOf(PRIYA)).not.toHaveProperty('onboarding.done');
  });
});
