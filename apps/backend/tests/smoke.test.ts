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

  it('GET /api/health falls back to the root package version and Railway sha when build env is absent', async () => {
    const prev = { v: process.env.APP_VERSION, c: process.env.GIT_SHA, r: process.env.RAILWAY_GIT_COMMIT_SHA };
    // Empty strings, not deletions: the Dockerfile bakes the unset args as
    // empty env, so this is exactly what a Railway container sees.
    process.env.APP_VERSION = '';
    process.env.GIT_SHA = '';
    process.env.RAILWAY_GIT_COMMIT_SHA = 'railwaysha123';
    try {
      const r = await api('GET', '/api/health');
      const body = r.body as { version: string; commit: string };
      // Railway builds pass no release args — the root package.json version
      // (bumped on every dev push) is the truthful fallback, so the frontend
      // version display and deploy checks show the real release.
      const rootPkg = await import('../../../package.json');
      expect(body.version).toBe(rootPkg.version);
      expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(body.commit).toBe('railwaysha123');
    } finally {
      process.env.APP_VERSION = prev.v;
      process.env.GIT_SHA = prev.c;
      if (prev.r === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
      else process.env.RAILWAY_GIT_COMMIT_SHA = prev.r;
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
