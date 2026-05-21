import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

describe('refresh_tokens schema', () => {
  beforeAll(async () => { await resetDb(); });

  it('has the refresh_tokens table with expected columns + indexes', async () => {
    const db = getTestDb();
    const cols = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'refresh_tokens'
    `;
    const set = new Set(cols.map(c => c.column_name));
    for (const c of ['id','user_id','token_hash','family_id','expires_at','revoked_at','created_at']) {
      expect(set.has(c), `missing column ${c}`).toBe(true);
    }
    const idx = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='refresh_tokens'
    `;
    const inames = new Set(idx.map(i => i.indexname));
    for (const i of ['refresh_tokens_user_idx','refresh_tokens_family_idx','refresh_tokens_hash_idx']) {
      expect(inames.has(i), `missing index ${i}`).toBe(true);
    }
  });
});

import { issueRefresh, rotateRefresh, revokeFamily, revokeUserRefreshTokens } from '../src/auth';

describe('refresh-token helpers', () => {
  beforeAll(async () => { await resetDb(); });

  async function aUser(): Promise<string> {
    const db = getTestDb();
    return (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
  }

  it('issues, rotates, and detects reuse', async () => {
    const db = getTestDb();
    const uid = await aUser();
    const { raw } = await issueRefresh(db, uid);

    const rot = await rotateRefresh(db, raw);
    expect(rot.ok).toBe(true);
    if (rot.ok) expect(rot.userId).toBe(uid);

    const reuse = await rotateRefresh(db, raw);   // old token already rotated
    expect(reuse.ok).toBe(false);

    const after = rot.ok ? await rotateRefresh(db, rot.raw) : { ok: true };
    expect(after.ok).toBe(false);                 // family revoked by reuse
  });

  it('revokeUserRefreshTokens kills all of a user\'s tokens', async () => {
    const db = getTestDb();
    const uid = await aUser();
    const { raw } = await issueRefresh(db, uid);
    await revokeUserRefreshTokens(db, uid);
    expect((await rotateRefresh(db, raw)).ok).toBe(false);
  });
});

import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('login/refresh/logout cookies', () => {
  beforeAll(async () => { await resetDb(); });

  it('login sets at + rt cookies (cookie-only: no token body)', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: ALEX, password: 'demo' },
      headers: { 'X-Requested-By': 'recycle-erp' },
    });
    expect(r.status).toBe(200);
    const setc = r.headers.get('set-cookie') ?? '';
    expect(setc).toMatch(/at=/);
    expect(setc).toMatch(/rt=/);
    expect(setc).toMatch(/HttpOnly/i);
    expect((r.body as { token?: string }).token).toBeUndefined(); // cookie-only
  });

  it('refresh rotates and reissues; logout revokes the family', async () => {
    const login = await api('POST', '/api/auth/login', {
      body: { email: ALEX, password: 'demo' }, headers: { 'X-Requested-By': 'recycle-erp' },
    });
    const sc = (login.headers.get('set-cookie') ?? '');
    const rt = /(?:^|[ ,;])rt=([^;]+)/.exec(sc)?.[1] ?? '';
    expect(rt).toBeTruthy();

    const refreshed = await api('POST', '/api/auth/refresh', {
      headers: { Cookie: `rt=${rt}`, 'X-Requested-By': 'recycle-erp' },
    });
    expect(refreshed.status).toBe(200);
    const sc2 = refreshed.headers.get('set-cookie') ?? '';
    expect(sc2).toMatch(/at=/);
    const rt2 = /(?:^|[ ,;])rt=([^;]+)/.exec(sc2)?.[1] ?? '';
    expect(rt2).toBeTruthy();
    expect(rt2).not.toBe(rt); // rotated

    // replay of the old rt → 401 (and family revoked)
    const replay = await api('POST', '/api/auth/refresh', {
      headers: { Cookie: `rt=${rt}`, 'X-Requested-By': 'recycle-erp' },
    });
    expect(replay.status).toBe(401);

    // the rotated rt2 is now dead too (family revoked by the replay)
    const dead = await api('POST', '/api/auth/refresh', {
      headers: { Cookie: `rt=${rt2}`, 'X-Requested-By': 'recycle-erp' },
    });
    expect(dead.status).toBe(401);

    // fresh login → logout → that rt cannot refresh
    const l2 = await api('POST', '/api/auth/login', {
      body: { email: ALEX, password: 'demo' }, headers: { 'X-Requested-By': 'recycle-erp' },
    });
    const rt3 = /(?:^|[ ,;])rt=([^;]+)/.exec(l2.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const out = await api('POST', '/api/auth/logout', {
      headers: { Cookie: `rt=${rt3}`, 'X-Requested-By': 'recycle-erp' },
    });
    expect(out.status).toBe(200);
    const afterLogout = await api('POST', '/api/auth/refresh', {
      headers: { Cookie: `rt=${rt3}`, 'X-Requested-By': 'recycle-erp' },
    });
    expect(afterLogout.status).toBe(401);
  });
});

import { csrfGuard } from '../src/csrf';

describe('csrfGuard', () => {
  function ctx(method: string, path: string, header?: string) {
    return {
      req: { method, path, header: (_: string) => header },
      json: (b: unknown, s?: number) => ({ __json: b, __status: s ?? 200 }),
    } as never;
  }
  it('allows safe methods, /api/health, and public vendor; blocks header-less mutations', async () => {
    let nexted = false; const next = async () => { nexted = true; };
    await csrfGuard(ctx('GET', '/api/orders') as never, next);
    expect(nexted).toBe(true);
    nexted = false;
    await csrfGuard(ctx('GET', '/api/health') as never, next);
    expect(nexted).toBe(true);
    nexted = false;
    await csrfGuard(ctx('POST', '/api/public/vendor/bid') as never, next);
    expect(nexted).toBe(true);            // external unauth submission — no header required
    nexted = false;
    const blocked = await csrfGuard(ctx('POST', '/api/orders') as never, next) as never as { __status: number };
    expect(nexted).toBe(false);
    expect(blocked.__status).toBe(403);
    nexted = false;
    await csrfGuard(ctx('POST', '/api/orders', 'recycle-erp') as never, next);
    expect(nexted).toBe(true);
  });
});

describe('deactivation revokes refresh tokens', () => {
  beforeAll(async () => { await resetDb(); });
  it('stamps revoked_at on the user\'s refresh tokens when deactivated', async () => {
    const db = getTestDb();
    const mgr = await loginAs(ALEX);
    const target = (await db<{ id: string }[]>`
      SELECT id FROM users WHERE role='purchaser' AND active
      ORDER BY created_at, id LIMIT 1`)[0].id;
    await issueRefresh(db, target);

    const before = (await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM refresh_tokens
      WHERE user_id = ${target} AND revoked_at IS NULL`)[0].n;
    expect(before).toBeGreaterThan(0);                 // a live token exists

    const del = await api('DELETE', `/api/members/${target}`, {
      token: mgr.token, headers: { 'X-Requested-By': 'recycle-erp' },
    });
    expect(del.status).toBe(200);

    const liveAfter = (await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM refresh_tokens
      WHERE user_id = ${target} AND revoked_at IS NULL`)[0].n;
    expect(liveAfter).toBe(0);                          // ALL revoked by deactivation
  });
});

describe('cookie-only enforcement + CSRF', () => {
  beforeAll(async () => { await resetDb(); });
  it('authed GET works via cookies; login body has no token; CSRF-less mutation 403; no-auth 401', async () => {
    const login = await api('POST', '/api/auth/login', {
      body: { email: ALEX, password: 'demo' }, headers: { 'X-Requested-By': 'recycle-erp' },
    });
    expect(login.status).toBe(200);
    expect((login.body as { token?: string }).token).toBeUndefined(); // no token in body
    const s = await loginAs(ALEX);
    const ok = await api('GET', '/api/me', { cookies: s.cookies });
    expect(ok.status).toBe(200);
    const blocked = await api('POST', '/api/workspace', {
      cookies: s.cookies, headers: { 'X-Requested-By': '' }, body: { currency: 'USD' },
    });
    expect(blocked.status).toBe(403);
    const noauth = await api('GET', '/api/me', {});
    expect(noauth.status).toBe(401);
  });
});

describe('FU2 — rotateRefresh is race-safe (row-locked)', () => {
  beforeAll(async () => { await resetDb(); });

  it('concurrent rotations of the same token yield exactly one winner', async () => {
    const db = getTestDb();
    const uid = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { raw } = await issueRefresh(db, uid);

    // Fire several rotations of the SAME raw token simultaneously. Without a
    // row lock, multiple reads see revoked_at IS NULL and each issues a live
    // successor (oversell of the rotation chain). With FOR UPDATE the row
    // serializes: exactly one wins; the rest hit the already-revoked/reuse
    // path.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => rotateRefresh(db, raw)),
    );
    const wins = results.filter(r => r.ok).length;
    expect(wins).toBe(1);

    // Invariant: never two live (non-revoked, unexpired) tokens in the family.
    const live = (await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM refresh_tokens
      WHERE user_id = ${uid} AND revoked_at IS NULL
    `)[0].n;
    expect(live).toBeLessThanOrEqual(1);
  });
});
