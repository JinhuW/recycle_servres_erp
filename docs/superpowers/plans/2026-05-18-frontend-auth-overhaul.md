# Frontend Auth Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the localStorage JWT bearer scheme with httpOnly access+refresh cookies (rotating, server-revocable) plus a SameSite=Lax + custom-header CSRF defense, with zero net test regressions.

**Architecture:** Same-origin app (Caddy/Vite proxy `/api`). Short-lived access JWT in httpOnly cookie `at` (`Path=/`, 15m); opaque rotating refresh token in httpOnly cookie `rt` (`Path=/api/auth`, 14d) hashed in a `refresh_tokens` table with family-based reuse detection. Cutover is sequenced additive-then-lockstep so every commit leaves the suite green.

**Tech Stack:** Hono + postgres.js (backend), React + fetch (frontend), vitest. Cookie helpers via `hono/cookie`.

**Spec:** `docs/superpowers/specs/2026-05-18-frontend-auth-overhaul-design.md`

---

## Parallel-WIP guardrails (read first)

The working tree has unrelated uncommitted vendor-bids WIP on `main`. The executor MUST NOT modify or revert: `apps/backend/src/routes/vendorPublic.ts`, `apps/backend/migrations/0033_vendor_bidding.sql`, or the user's `apps/backend/scripts/migrate.mjs` changes. New migrations in this plan use `0034+` (no collision). `/api/public/vendor/*` is an **unauthenticated external** route — the CSRF guard and the cookie auth middleware must leave it alone (handled in Task 4/Task 7). Do not "fix" the pre-existing duplicate `0033_` numbering.

---

## File Structure

- `apps/backend/migrations/0034_refresh_tokens.sql` — **create**: refresh-token store.
- `apps/backend/src/auth.ts` — **modify**: 15m access TTL; cookie helpers; refresh issue/rotate/revoke; middleware reads cookie.
- `apps/backend/src/routes/auth.ts` — **modify**: login sets cookies; add `/refresh`, `/logout`.
- `apps/backend/src/csrf.ts` — **create**: CSRF middleware.
- `apps/backend/src/index.ts` — **modify**: mount CSRF middleware.
- `apps/backend/src/services/members.ts` — **modify**: deactivate revokes refresh tokens.
- `apps/backend/src/routes/members.ts` — **modify**: call the revoke on deactivate.
- `apps/backend/tests/helpers/app.ts` / `helpers/auth.ts` — **modify**: cookie jar + CSRF header, signatures preserved.
- `apps/backend/tests/auth-cookies.test.ts` — **create**: refresh/rotation/reuse/logout/CSRF/deactivation tests.
- `apps/frontend/src/lib/api.ts` — **modify**: credentials + CSRF header + single-flight refresh-on-401.
- `apps/frontend/src/lib/auth.tsx` — **modify**: cookie bootstrap, logout endpoint, remove `tokenStore`.

Each command runs from `apps/backend` unless noted. Backend tests: `npx vitest run <file>`. Commits: working tree is WIP on `main`; commit only the files each task lists.

---

## Task 1: refresh_tokens migration

**Files:**
- Create: `apps/backend/migrations/0034_refresh_tokens.sql`
- Test: `apps/backend/tests/auth-cookies.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/auth-cookies.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth-cookies.test.ts`
Expected: FAIL — `missing column id` (table does not exist).

- [ ] **Step 3: Write the migration**

Create `apps/backend/migrations/0034_refresh_tokens.sql`:

```sql
-- Rotating refresh-token store for cookie-based auth. token_hash is the
-- SHA-256 of the opaque refresh secret (the raw value is never stored).
-- family_id groups a rotation chain so reuse of a rotated token can revoke
-- the whole family (theft response). Idempotent — resetDb/migrate replay it.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   UUID NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_hash_idx   ON refresh_tokens(token_hash);
```

(`gen_random_uuid()` is available — pgcrypto/pg13+ is already relied on by existing migrations.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth-cookies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0034_refresh_tokens.sql apps/backend/tests/auth-cookies.test.ts
git commit -m "feat(auth): add refresh_tokens table"
```

---

## Task 2: auth.ts — cookie + refresh-token helpers (additive)

**Files:**
- Modify: `apps/backend/src/auth.ts`
- Test: `apps/backend/tests/auth-cookies.test.ts`

Current `auth.ts` exposes `signToken(env,{id,email,role})` (14d) and `verifyToken`. Keep them; **change the access TTL to 15m** and add helpers. Refresh raw token = 32 random bytes hex; stored hash = SHA-256 hex (Node `crypto`).

- [ ] **Step 1: Write the failing test** — append to `tests/auth-cookies.test.ts`:

```ts
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

    // Old token now revoked → reuse must fail AND revoke the family.
    const reuse = await rotateRefresh(db, raw);
    expect(reuse.ok).toBe(false);

    // The rotated-to token is now also dead (family revoked by the reuse).
    const after = rot.ok ? await rotateRefresh(db, rot.raw) : { ok: true };
    expect(after.ok).toBe(false);
  });

  it('revokeUserRefreshTokens kills all of a user\'s tokens', async () => {
    const db = getTestDb();
    const uid = await aUser();
    const { raw } = await issueRefresh(db, uid);
    await revokeUserRefreshTokens(db, uid);
    expect((await rotateRefresh(db, raw)).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth-cookies.test.ts -t "refresh-token helpers"`
Expected: FAIL — `issueRefresh` is not exported.

- [ ] **Step 3: Implement helpers in `apps/backend/src/auth.ts`**

Add near the top: `import { createHash, randomBytes } from 'node:crypto';` and a `postgres`-typed import consistent with the file (use the existing `Sql`/`TransactionSql` style already in the codebase — accept `any`-free `import type postgres from 'postgres'` and type params `postgres.Sql | postgres.TransactionSql`).

Change the access-token expiry constant to 15 minutes (locate the existing `exp`/`14`-day logic in `signToken` and set it to `now + 15*60`). Then append:

```ts
const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function issueRefresh(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
  familyId?: string,
): Promise<{ raw: string; familyId: string }> {
  const raw = randomBytes(32).toString('hex');
  const fam = familyId ?? crypto.randomUUID();
  const expires = new Date(Date.now() + REFRESH_TTL_MS);
  await sql`
    INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
    VALUES (${userId}, ${sha256(raw)}, ${fam}, ${expires})
  `;
  return { raw, familyId: fam };
}

export type RotateResult =
  | { ok: true; userId: string; raw: string; familyId: string }
  | { ok: false };

// Validate a presented refresh token. If valid+active: revoke it and issue
// the next token in the same family. If it was already revoked (reuse/theft):
// revoke the entire family and fail.
export async function rotateRefresh(
  sql: postgres.Sql | postgres.TransactionSql,
  raw: string,
): Promise<RotateResult> {
  const row = (await sql<{
    id: string; user_id: string; family_id: string;
    revoked_at: string | null; expired: boolean; active: boolean;
  }[]>`
    SELECT rt.id, rt.user_id, rt.family_id, rt.revoked_at,
           (rt.expires_at <= NOW()) AS expired,
           u.active AS active
    FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
    WHERE rt.token_hash = ${sha256(raw)} LIMIT 1
  `)[0];
  if (!row) return { ok: false };
  if (row.revoked_at) {                       // reuse of a rotated token
    await revokeFamily(sql, row.family_id);
    return { ok: false };
  }
  if (row.expired || !row.active) return { ok: false };
  await sql`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ${row.id}`;
  const next = await issueRefresh(sql, row.user_id, row.family_id);
  return { ok: true, userId: row.user_id, raw: next.raw, familyId: row.family_id };
}

export async function revokeFamily(
  sql: postgres.Sql | postgres.TransactionSql, familyId: string,
): Promise<void> {
  await sql`UPDATE refresh_tokens SET revoked_at = NOW()
            WHERE family_id = ${familyId} AND revoked_at IS NULL`;
}

export async function revokeUserRefreshTokens(
  sql: postgres.Sql | postgres.TransactionSql, userId: string,
): Promise<void> {
  await sql`UPDATE refresh_tokens SET revoked_at = NOW()
            WHERE user_id = ${userId} AND revoked_at IS NULL`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/auth-cookies.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/auth.ts apps/backend/tests/auth-cookies.test.ts
git commit -m "feat(auth): refresh issue/rotate/revoke helpers; 15m access TTL"
```

---

## Task 3: cookie helpers + login sets cookies + /refresh + /logout (additive — bearer still works)

**Files:**
- Modify: `apps/backend/src/auth.ts` (cookie option helper)
- Modify: `apps/backend/src/routes/auth.ts`
- Test: `apps/backend/tests/auth-cookies.test.ts`

`authMiddleware` is NOT changed yet (still bearer) and login STILL returns `token` in the body, so all existing tests stay green. We only ADD cookie issuance + endpoints.

- [ ] **Step 1: Write the failing test** — append:

```ts
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

function cookieMap(setCookie: string[] | string | null): Record<string,string> {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const m: Record<string,string> = {};
  for (const c of arr) { const [kv] = c.split(';'); const i = kv.indexOf('='); m[kv.slice(0,i).trim()] = kv.slice(i+1); }
  return m;
}

describe('login/refresh/logout cookies', () => {
  beforeAll(async () => { await resetDb(); });

  it('login sets at + rt cookies', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: ALEX, password: 'demo' },
      headers: { 'X-Requested-By': 'recycle-erp' },
    });
    expect(r.status).toBe(200);
    const setc = r.headers.get('set-cookie');
    expect(setc).toMatch(/(^|,| )at=/);
    expect(setc).toMatch(/rt=/);
    expect(setc).toMatch(/HttpOnly/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth-cookies.test.ts -t "login sets at"`
Expected: FAIL — no `at=`/`rt=` in Set-Cookie.

- [ ] **Step 3: Implement**

In `apps/backend/src/auth.ts` add a cookie-options helper (used by routes):

```ts
import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types';

function secureFlag(env: Env): boolean { return (env as Env).NODE_ENV === 'production'; }

export function setAuthCookies(c: Context, env: Env, accessJwt: string, refreshRaw: string) {
  const secure = secureFlag(env);
  setCookie(c, 'at', accessJwt, {
    httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 15 * 60,
  });
  setCookie(c, 'rt', refreshRaw, {
    httpOnly: true, sameSite: 'Lax', secure, path: '/api/auth',
    maxAge: 14 * 24 * 60 * 60,
  });
}
export function clearAuthCookies(c: Context, env: Env) {
  const secure = secureFlag(env);
  deleteCookie(c, 'at', { path: '/', secure });
  deleteCookie(c, 'rt', { path: '/api/auth', secure });
}
```

In `apps/backend/src/routes/auth.ts`:
- import `signToken` (already), `issueRefresh`, `rotateRefresh`, `revokeFamily`, `setAuthCookies`, `clearAuthCookies`, and `getCookie` from `hono/cookie`.
- In the existing `/login` success path, before returning, after computing `token` (keep returning it for now):

```ts
const { raw: refreshRaw } = await issueRefresh(sql, u.id);
setAuthCookies(c, c.env as Env, token, refreshRaw);
```

- Add the endpoints (mounted under the already-public `/api/auth`):

```ts
// Rotate the refresh cookie and reissue a fresh access cookie. Authenticated
// by the rt cookie itself (NOT the access middleware), so an expired at is OK.
auth.post('/refresh', async (c) => {
  const raw = getCookie(c, 'rt');
  if (!raw) return c.json({ error: 'no refresh token' }, 401);
  const sql = getDb(c.env);
  const res = await rotateRefresh(sql, raw);
  if (!res.ok) { clearAuthCookies(c, c.env as Env); return c.json({ error: 'invalid refresh' }, 401); }
  const at = await signToken(c.env, { id: res.userId, email: '', role: '' } as never);
  // signToken only needs id for the middleware lookup; email/role are re-read
  // from the DB by authMiddleware. If signToken requires real email/role,
  // fetch them: see note below.
  setAuthCookies(c, c.env as Env, at, res.raw);
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  const raw = getCookie(c, 'rt');
  if (raw) {
    const sql = getDb(c.env);
    const row = (await sql<{ family_id: string }[]>`
      SELECT family_id FROM refresh_tokens WHERE token_hash =
        encode(digest(${raw}, 'sha256'),'hex') LIMIT 1
    `)[0];
    if (row) await revokeFamily(sql, row.family_id);
  }
  clearAuthCookies(c, c.env as Env);
  return c.json({ ok: true });
});
```

**signToken note:** if `signToken` embeds `email`/`role` in the JWT and they must be real, replace the `/refresh` token line with a user lookup:

```ts
const u = (await sql<{ id:string; email:string; role:string }[]>`
  SELECT id,email,role FROM users WHERE id = ${res.userId} AND active LIMIT 1`)[0];
if (!u) { clearAuthCookies(c, c.env as Env); return c.json({ error: 'invalid refresh' }, 401); }
const at = await signToken(c.env, { id: u.id, email: u.email, role: u.role });
```

Use this lookup form (it is correct regardless of signToken's claim set). The `logout` SHA uses pgcrypto `digest`; if `digest` is unavailable, instead `import { createHash } from 'node:crypto'` and pass `${createHash('sha256').update(raw).digest('hex')}`.

- [ ] **Step 4: Run to verify it passes + no regressions**

Run: `npx vitest run tests/auth-cookies.test.ts tests/smoke.test.ts tests/login-rate-limit.test.ts`
Expected: PASS. Bearer-based tests unaffected (login still returns `token`).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/auth.ts apps/backend/src/routes/auth.ts apps/backend/tests/auth-cookies.test.ts
git commit -m "feat(auth): issue auth cookies on login; add /refresh and /logout"
```

---

## Task 4: CSRF middleware (created, NOT yet mounted)

**Files:**
- Create: `apps/backend/src/csrf.ts`
- Test: `apps/backend/tests/auth-cookies.test.ts`

Build + unit-test the middleware in isolation. It is mounted globally in Task 6 (lockstep with the harness sending the header) so existing tests don't break early.

- [ ] **Step 1: Write the failing test** — append:

```ts
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
    // External unauthenticated vendor submission — must NOT require the header.
    await csrfGuard(ctx('POST', '/api/public/vendor/bid') as never, next);
    expect(nexted).toBe(true);
    nexted = false;
    const blocked = await csrfGuard(ctx('POST', '/api/orders') as never, next) as never as { __status: number };
    expect(nexted).toBe(false);
    expect(blocked.__status).toBe(403);
    nexted = false;
    await csrfGuard(ctx('POST', '/api/orders', 'recycle-erp') as never, next);
    expect(nexted).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth-cookies.test.ts -t "csrfGuard"`
Expected: FAIL — `csrfGuard` not exported.

- [ ] **Step 3: Implement `apps/backend/src/csrf.ts`**

```ts
import type { Context, Next } from 'hono';

// Same-site SPA defense-in-depth: every state-changing request must carry a
// header the browser will not attach cross-site without an explicit CORS
// preflight the API does not grant. Safe methods and the unauthenticated
// health probe are exempt.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// Unauthenticated, externally-called endpoints carry no SPA header and are not
// cookie-authenticated, so CSRF (a cookie-confused-deputy attack) does not
// apply: the health probe and the public vendor-bid intake.
function exempt(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/public/');
}
export async function csrfGuard(c: Context, next: Next) {
  if (SAFE.has(c.req.method)) return next();
  if (exempt(c.req.path)) return next();
  if (c.req.header('X-Requested-By') !== 'recycle-erp') {
    return c.json({ error: 'CSRF check failed' }, 403);
  }
  return next();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/auth-cookies.test.ts -t "csrfGuard"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/csrf.ts apps/backend/tests/auth-cookies.test.ts
git commit -m "feat(auth): CSRF guard middleware (not yet mounted)"
```

---

## Task 5: deactivating a member revokes their refresh tokens

**Files:**
- Modify: `apps/backend/src/services/members.ts`
- Modify: `apps/backend/src/routes/members.ts`
- Test: `apps/backend/tests/auth-cookies.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
import { loginAs as _la } from './helpers/auth';
describe('deactivation revokes refresh tokens', () => {
  beforeAll(async () => { await resetDb(); });
  it('a deactivated user cannot refresh', async () => {
    const db = getTestDb();
    const mgr = await loginAs(ALEX);
    const target = (await db<{ id:string }[]>`
      SELECT id FROM users WHERE role='purchaser' AND active LIMIT 1`)[0].id;
    const { raw } = await issueRefresh(db, target);
    const del = await api('DELETE', `/api/members/${target}`, {
      token: mgr.token, headers: { 'X-Requested-By': 'recycle-erp' },
    });
    expect(del.status).toBe(200);
    const { rotateRefresh } = await import('../src/auth');
    expect((await rotateRefresh(db, raw)).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth-cookies.test.ts -t "deactivated user cannot refresh"`
Expected: FAIL — token still rotates (revoke not wired).

- [ ] **Step 3: Implement**

In `apps/backend/src/services/members.ts`, add to the existing `deactivateMember` (after it sets `active=false`), or expose a helper the route calls. Simplest: in `deactivateMember(sql, id)` add:

```ts
await sql`UPDATE refresh_tokens SET revoked_at = NOW()
          WHERE user_id = ${id} AND revoked_at IS NULL`;
```

(If `deactivateMember` returns early on "no row", keep the revoke after the successful update only.)

No change needed in `routes/members.ts` if the service handles it; otherwise call `revokeUserRefreshTokens(sql, id)` from the route right after `deactivateMember` succeeds.

- [ ] **Step 4: Run to verify it passes + members suite**

Run: `npx vitest run tests/auth-cookies.test.ts tests/members.test.ts tests/members-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/members.ts apps/backend/src/routes/members.ts apps/backend/tests/auth-cookies.test.ts
git commit -m "feat(auth): revoke refresh tokens when a member is deactivated"
```

---

## Task 6: Test-harness cookie jar + CSRF header (signatures preserved)

**Files:**
- Modify: `apps/backend/tests/helpers/app.ts`
- Modify: `apps/backend/tests/helpers/auth.ts`
- Test: existing suites (regression — they must stay green BEFORE the cutover)

This makes the harness send the CSRF header and use cookies from login, while the backend still also accepts bearer (so this task alone changes nothing functionally — it is the safety net installed before Task 7 flips the cutover).

- [ ] **Step 1: Capture baseline**

Run: `npx vitest run tests/smoke.test.ts tests/orders.test.ts`
Expected: PASS (record as baseline).

- [ ] **Step 2: Modify `helpers/app.ts`**

Add to the `ApiOpts`: an optional `cookies?: Record<string,string>`. In `api()`:
- always add header `'X-Requested-By': 'recycle-erp'` (unless caller overrode it);
- if `opts.cookies`, add `Cookie: Object.entries(cookies).map(([k,v])=>\`${k}=${v}\`).join('; ')`;
- after `await app.fetch(...)`, parse `res.headers.get('set-cookie')` into a map and expose it on the result as `setCookies` (add to `ApiResult`).
- Keep the existing `opts.token` behavior (still sets `Authorization: Bearer`), because the backend still accepts bearer until Task 7; this guarantees zero regressions in this task.

Apply the same `X-Requested-By` default + cookie support to `multipart()`.

- [ ] **Step 3: Modify `helpers/auth.ts`**

`loginAs(email,password)` currently returns `{ token, user }`. Change it to also perform cookie capture and return a `session`:

```ts
export type LoginResult = { token: string; user: User; cookies: Record<string,string> };
export async function loginAs(email: string, password = 'demo'): Promise<LoginResult> {
  const r = await api('POST', '/api/auth/login', {
    body: { email, password }, headers: { 'X-Requested-By': 'recycle-erp' },
  });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return { token: (r.body as any).token, user: (r.body as any).user, cookies: r.setCookies ?? {} };
}
```

Return shape stays a superset of the old one (`token`, `user` still present) so existing destructuring keeps working.

- [ ] **Step 4: Run regression**

Run: `npx vitest run tests/smoke.test.ts tests/orders.test.ts tests/members.test.ts tests/sell-orders.test.ts`
Expected: PASS (still bearer-driven; harness changes are inert).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/tests/helpers/app.ts apps/backend/tests/helpers/auth.ts
git commit -m "test(auth): harness cookie jar + CSRF header (inert until cutover)"
```

---

## Task 7: Cutover — cookie-only auth + CSRF enforced (lockstep)

**Files:**
- Modify: `apps/backend/src/auth.ts` (authMiddleware reads `at` cookie, drop bearer)
- Modify: `apps/backend/src/routes/auth.ts` (login stops returning `token`)
- Modify: `apps/backend/src/index.ts` (mount `csrfGuard`)
- Modify: `apps/backend/tests/helpers/app.ts` / `helpers/auth.ts` (drive via cookies)
- Test: full suite

- [ ] **Step 1: Write the failing test** — append to `tests/auth-cookies.test.ts`:

```ts
describe('cookie-only enforcement', () => {
  beforeAll(async () => { await resetDb(); });
  it('an authed GET works via cookies and a mutation without CSRF header is 403', async () => {
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth-cookies.test.ts -t "cookie-only enforcement"`
Expected: FAIL — `/api/me` via cookies is 401 (middleware still bearer-only) and/or CSRF not enforced.

- [ ] **Step 3: Implement the cutover**

`apps/backend/src/auth.ts` — in `authMiddleware`, replace the bearer extraction with cookie read:

```ts
import { getCookie } from 'hono/cookie';
// inside authMiddleware:
const token = getCookie(c, 'at') || '';
// (delete the `const header = c.req.header('Authorization')...` lines)
```

`apps/backend/src/routes/auth.ts` — in `/login`, stop putting `token` in the JSON body; return `{ user: {...} }` only (cookies already set in Task 3).

`apps/backend/src/index.ts` — mount the guard before route mounting and before/after `authMiddleware` lines but globally:

```ts
import { csrfGuard } from './csrf';
app.use('*', csrfGuard);
```

(Place it directly after the CORS `app.use` and before the `app.use('*', dbScope...)` line.)

`apps/backend/tests/helpers/auth.ts` — `loginAs` now has no `token` in the body; set `token: ''` in the result (kept for type compatibility) and rely on `cookies`.

`apps/backend/tests/helpers/app.ts` — change `api()`/`multipart()` so that when `opts.token` is the old positional usage, callers actually pass `cookies`. To keep ~37 files unchanged: make `loginAs` return `cookies`, and update `api()` so that **if `opts.token` is falsy but a module-level "current session" is set, use it** is NOT desired (global state). Instead: keep the explicit pattern but provide a back-compat shim — `api()` accepts `opts.token` and, when present and non-empty, treats it as a bearer (still works ONLY if backend accepts it — it no longer does). Therefore the minimal-churn approach is: keep `loginAs` returning `cookies`, and do a **mechanical search-replace** across `tests/**` of the common call patterns:
  - `loginAs(X)` destructured as `{ token }` → `{ cookies }`
  - `api('M', '/p', { token })` → `api('M', '/p', { cookies })`

Most tests use `const { token } = await loginAs(...)` then `{ token }`. The replacement is uniform. Apply with care per file; run the suite after.

  > Implementation note for the executor: do this file-by-file, running that file's suite after each, committing in small batches. The signatures still accept the old `token` key (typed optional) so partially-migrated files compile; only behavior requires `cookies`.

- [ ] **Step 4: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (37+ files). Investigate any file still passing `token` instead of `cookies` and fix.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src apps/backend/tests
git commit -m "feat(auth)!: cookie-only auth + CSRF enforced; migrate test harness"
```

---

## Task 8: Frontend api client — credentials, CSRF header, silent refresh

**Files:**
- Modify: `apps/frontend/src/lib/api.ts`
- Verify: `pnpm --filter recycle-erp-frontend typecheck && build && test`

- [ ] **Step 1: Write the failing test**

Add `apps/frontend/tests/api-refresh.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub global fetch: first call 401, /api/auth/refresh 200, retried call 200.
describe('api silent refresh', () => {
  beforeEach(() => vi.resetModules());
  it('refreshes once on 401 then retries the original', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/orders' && calls.filter(c=>c.includes('/api/orders')).length === 1)
        return new Response('{}', { status: 401 });
      if (url === '/api/auth/refresh') return new Response('{"ok":true}', { status: 200 });
      return new Response('{"ok":true}', { status: 200 });
    }) as any;
    const { api } = await import('../src/lib/api');
    const r = await api.get('/api/orders');
    expect(r).toBeTruthy();
    expect(calls).toContain('POST /api/auth/refresh');
    expect(calls.filter(c => c === 'GET /api/orders').length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter recycle-erp-frontend exec vitest run tests/api-refresh.test.ts`
Expected: FAIL — current api.ts has no refresh; uses Authorization/localStorage.

- [ ] **Step 3: Implement** in `apps/frontend/src/lib/api.ts`

- Remove the `auth`/`tokenStore` localStorage object and the `Authorization` header logic.
- Every request: add `credentials: 'include'` and header `'X-Requested-By': 'recycle-erp'`.
- Wrap the core request so a `401` (except for `/api/auth/refresh` itself) triggers a single-flight refresh then one retry:

```ts
let refreshing: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', {
      method: 'POST', credentials: 'include',
      headers: { 'X-Requested-By': 'recycle-erp' },
    }).then(r => r.ok).catch(() => false).finally(() => { refreshing = null; });
  }
  return refreshing;
}
// in request(): after the fetch, if res.status === 401 && path !== '/api/auth/refresh':
//   if (await tryRefresh()) { /* re-issue the identical fetch once */ }
//   else { window.dispatchEvent(new Event('auth:unauthorized')); throw new ApiError(401,...) }
```

Keep `ApiError` and the `auth:unauthorized` event name (auth.tsx depends on it).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter recycle-erp-frontend exec vitest run tests/api-refresh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/api.ts apps/frontend/tests/api-refresh.test.ts
git commit -m "feat(auth): cookie api client with single-flight refresh-on-401"
```

---

## Task 9: Frontend auth context — cookie bootstrap + logout endpoint

**Files:**
- Modify: `apps/frontend/src/lib/auth.tsx`
- Verify: frontend typecheck/build/test

- [ ] **Step 1: Write the failing test**

Add `apps/frontend/tests/auth-bootstrap.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
describe('auth bootstrap via cookie', () => {
  it('restores the user from /api/me without any stored token', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (url === '/api/me') return new Response(JSON.stringify({ user: { id:'u1', role:'manager', email:'a@b.c' }}), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as any;
    localStorage.clear();
    const mod = await import('../src/lib/auth');
    expect(typeof mod.AuthProvider).toBe('function');
    // Smoke: module imports with no tokenStore reference.
    expect((mod as any).tokenStore).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter recycle-erp-frontend exec vitest run tests/auth-bootstrap.test.ts`
Expected: FAIL — `tokenStore` still exported / referenced.

- [ ] **Step 3: Implement** in `apps/frontend/src/lib/auth.tsx`

- Delete the `tokenStore` import/usage. Bootstrap effect: instead of `if (!tokenStore.token) return;`, always attempt `await api.get('/api/me')`; on success set user + load lookups/workspace (keep existing failure tolerance); on `ApiError 401` treat as logged-out (no console error).
- `login()`: `await api.post('/api/auth/login', {email,password})` → response `{ user }`; set user; no token storage.
- `logout()`: `await api.post('/api/auth/logout').catch(()=>{})` then clear local state; keep the `auth:unauthorized` listener calling `logout`.

- [ ] **Step 4: Run to verify it passes + full frontend gate**

Run: `pnpm --filter recycle-erp-frontend typecheck && pnpm --filter recycle-erp-frontend build && pnpm --filter recycle-erp-frontend test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/auth.tsx apps/frontend/tests/auth-bootstrap.test.ts
git commit -m "feat(auth): cookie-based bootstrap + server logout; remove token storage"
```

---

## Task 10: Full verification + cleanup

**Files:** none (verification) — plus delete any now-dead `recycle_erp_token` references.

- [ ] **Step 1:** `grep -rn "localStorage\|recycle_erp_token\|Authorization: \`Bearer\|tokenStore" apps/frontend/src apps/backend/src` → expect no auth-token hits (cookie-only).
- [ ] **Step 2:** Backend full gate: `cd apps/backend && npx tsc --noEmit && npx vitest run` → all green (record file/test counts).
- [ ] **Step 3:** Frontend full gate: `pnpm --filter recycle-erp-frontend typecheck && build && test` → all green.
- [ ] **Step 4:** Manual smoke notes (document, no code): login sets `at`/`rt`; deleting `at` cookie then any call silently refreshes; deleting `rt` too → bounced to login; logout clears both and a stale `rt` no longer refreshes.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(auth): remove dead token-storage references; full green"
```

---

## Self-Review

- **Spec coverage:** token model (T1–T3), CSRF Lax+header (T4,T7), refresh/rotation/reuse (T2,T3), logout revoke (T3), deactivation revoke (T5), frontend client+bootstrap (T8,T9), test-harness migration (T6,T7), error handling (T3,T8). All spec sections mapped.
- **Placeholder scan:** no TBD/TODO; all code blocks concrete. The `signToken` claim-set uncertainty is resolved by mandating the DB-lookup form in T3.
- **Type consistency:** `issueRefresh`→`{raw,familyId}`, `rotateRefresh`→`RotateResult` used consistently T2/T3/T5; `setAuthCookies`/`clearAuthCookies`/`csrfGuard`/`revokeUserRefreshTokens` names stable across tasks; `loginAs` returns `{token,user,cookies}` superset used in T6/T7.
- **Sequencing:** additive (T1–T5) keeps bearer + green; T6 installs harness safety net inert; T7 flips cutover with harness already cookie-ready; frontend (T8–T9) independent. Every task ends green.

## Risks

- The bulk `{ token }`→`{ cookies }` test edit (T7) is mechanical but wide; mitigated by per-file run+commit and the optional-typed `token` key keeping partial states compiling.
- Commit cadence assumes the user is OK with commits on `main` (matches their stated workflow); if they prefer to review uncommitted, skip the `git commit` steps and treat each as a checkpoint.
