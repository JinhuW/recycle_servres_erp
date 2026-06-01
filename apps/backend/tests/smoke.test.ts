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

  it('GET /api/health reports the build version and commit from env', async () => {
    const prev = { v: process.env.APP_VERSION, c: process.env.GIT_SHA };
    process.env.APP_VERSION = '9.9.9';
    process.env.GIT_SHA = 'deadbee';
    try {
      const r = await api('GET', '/api/health');
      expect(r.status).toBe(200);
      const body = r.body as { status: string; version: string; commit: string };
      expect(body.status).toBe('ok');
      expect(body.version).toBe('9.9.9');
      expect(body.commit).toBe('deadbee');
    } finally {
      process.env.APP_VERSION = prev.v;
      process.env.GIT_SHA = prev.c;
    }
  });

  it('GET /api/health falls back to dev/unknown when build env is absent', async () => {
    const prev = { v: process.env.APP_VERSION, c: process.env.GIT_SHA };
    delete process.env.APP_VERSION;
    delete process.env.GIT_SHA;
    try {
      const r = await api('GET', '/api/health');
      const body = r.body as { version: string; commit: string };
      expect(body.version).toBe('dev');
      expect(body.commit).toBe('unknown');
    } finally {
      process.env.APP_VERSION = prev.v;
      process.env.GIT_SHA = prev.c;
    }
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
