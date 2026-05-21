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

  it('GET /api/health is unauthenticated and reports ok when the DB is up', async () => {
    const r = await api('GET', '/api/health');
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe('ok');
  });

  it('GET /api/health returns 503 when the DB is unreachable', async () => {
    const r = await api('GET', '/api/health', {
      env: { DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none' },
    });
    expect(r.status).toBe(503);
    expect((r.body as { status: string }).status).toBe('error');
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
