import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('smoke', () => {
  beforeAll(async () => { await resetDb(); });

  it('GET / returns service banner', async () => {
    const r = await api('GET', '/');
    expect(r.status).toBe(200);
    expect((r.body as { service: string }).service).toBe('recycle-erp-backend');
  });

  it('login as manager returns a JWT', async () => {
    const { token, user } = await loginAs(ALEX);
    expect(token).toMatch(/^eyJ/);
    expect(user.role).toBe('manager');
  });

  it('login as purchaser returns a JWT', async () => {
    const { token, user } = await loginAs(MARCUS);
    expect(token).toMatch(/^eyJ/);
    expect(user.role).toBe('purchaser');
  });
});
