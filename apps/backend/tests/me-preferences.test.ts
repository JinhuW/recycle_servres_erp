import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

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
  });
});
