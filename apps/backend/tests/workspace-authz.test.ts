import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Body = { settings: Record<string, unknown> };

describe('GET /api/workspace/ — role-scoped settings', () => {
  beforeAll(async () => { await resetDb(); });

  it('manager gets the full settings map', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<Body>('GET', '/api/workspace', { token });
    expect(r.status).toBe(200);
    expect(r.body.settings.target_margin).toBeDefined();
    expect(r.body.settings.low_margin_floor).toBeDefined();
    expect(r.body.settings.low_health_pct).toBeDefined();
  });

  it('purchaser gets the display thresholds the SPA needs, not pricing config', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<Body>('GET', '/api/workspace', { token });
    expect(r.status).toBe(200);
    expect(r.body.settings.low_health_pct).toBeDefined();
    for (const secret of [
      'target_margin', 'low_margin_floor', 'category_default_margin',
      'upload_max_bytes', 'upload_allowed_mime',
    ]) {
      expect(r.body.settings[secret]).toBeUndefined();
    }
  });

  it('purchaser still cannot write settings', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('PATCH', '/api/workspace', { token, body: { low_health_pct: 10 } });
    expect(r.status).toBe(403);
  });
});
