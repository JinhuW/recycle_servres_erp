import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('/api/workspace', () => {
  beforeEach(async () => { await resetDb(); });

  it('GET returns defaults', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ settings: Record<string, unknown> }>('GET', '/api/workspace', { token });
    expect(r.status).toBe(200);
    expect(r.body.settings.currency).toBe('USD');
    expect(r.body.settings.timezone).toBe('America/Los_Angeles');
  });

  it('PATCH manager can update', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/workspace', { token, body: { currency: 'HKD' } });
    expect(r.status).toBe(200);
    const got = await api<{ settings: Record<string, unknown> }>('GET', '/api/workspace', { token });
    expect(got.body.settings.currency).toBe('HKD');
  });

  it('PATCH purchaser is forbidden', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('PATCH', '/api/workspace', { token, body: { currency: 'EUR' } });
    expect(r.status).toBe(403);
  });
});
