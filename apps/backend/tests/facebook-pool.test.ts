import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

type Account = {
  no: number; uid: string; password: string; totp: string; email: string; emailPassword: string;
  recovery: string; cookie: string; token: string; note: string; status: string; holder: string | null;
  holderId: string | null; since: number | null; addedAt: number; cookieAt: number | null; batch: string;
};
type Activity = { at: number; who: string; action: string; accountNo?: number; detail?: string; status: string };
type Snapshot = { accounts: Account[]; activity: Activity[] };

const BASE = '/api/facebook-pool';
const uid = (n: number) => String(61556203481000 + n);
const draft = (n: number, over: Record<string, unknown> = {}) => ({
  uid: uid(n),
  password: `DemoOnly!${n}`,
  totp: 'JBSWY3DPEHPK3PXP',
  email: `acct${n}@outlook.example`,
  emailPassword: `Mail!${n}`,
  recovery: `rec${n}@mail.example`,
  cookie: `c_user=${uid(n)}; xs=session-${n}; datr=d`,
  token: `EAAtoken${n}`,
  note: `note ${n}`,
  status: 'available',
  holder: null,
  ...over,
});

async function manager() { return (await loginAs(ALEX)).token; }
async function seedPool(token: string, count: number, batch = 'Batch T') {
  const r = await api<Snapshot>('POST', `${BASE}/import`, {
    token, body: { batch, rows: Array.from({ length: count }, (_, i) => draft(i + 1)) },
  });
  expect(r.status).toBe(201);
  return r.body;
}

describe('facebook account pool', () => {
  beforeEach(async () => { await resetDb(); });

  it('stores accounts sealed, numbers them once and hands a manager the clear text', async () => {
    const token = await manager();
    const r = await api<Snapshot>('POST', BASE, { token, body: { draft: draft(1), batch: 'By hand' } });
    expect(r.status).toBe(201);
    const [a] = r.body.accounts;
    expect(a).toMatchObject({ no: 1, uid: uid(1), password: 'DemoOnly!1', totp: 'JBSWY3DPEHPK3PXP',
      emailPassword: 'Mail!1', recovery: 'rec1@mail.example', token: 'EAAtoken1',
      status: 'available', holder: null, batch: 'By hand' });
    expect(a.cookie).toContain('xs=session-1');
    expect(a.cookieAt).not.toBeNull();
    expect(r.body.activity[0]).toMatchObject({ who: 'Alex Chen', action: 'added', accountNo: 1, status: 'available' });

    const db = getTestDb();
    const [row] = await db<{ password_enc: string; cookie_enc: string; cookie_uid: string; token_enc: string }[]>`
      SELECT password_enc, cookie_enc, cookie_uid, token_enc FROM fb_pool_accounts WHERE no = 1`;
    expect(row.password_enc.startsWith('v1.')).toBe(true);
    expect(row.password_enc).not.toContain('DemoOnly');
    expect(row.cookie_enc).not.toContain('session-1');
    expect(row.cookie_uid).toBe(uid(1));
    expect(row.token_enc.startsWith('v1.')).toBe(true);
    expect(row.token_enc).not.toContain('EAAtoken1');

    // Removing #1 and adding another never reuses the number.
    expect((await api('DELETE', `${BASE}/1`, { token })).status).toBe(200);
    const r2 = await api<Snapshot>('POST', BASE, { token, body: { draft: draft(2) } });
    expect(r2.body.accounts.map((x) => x.no)).toEqual([2]);
    expect(r2.body.accounts[0].batch).toBe('Manual');
    expect(r2.body.activity.map((e) => e.action)).toEqual(['added', 'removed', 'added']);
    expect(r2.body.activity[1]).toMatchObject({ accountNo: 1, detail: uid(1) });
  });

  it('validates drafts with the shared rules and refuses a duplicate uid', async () => {
    const token = await manager();
    await seedPool(token, 1);
    const bad = await api<{ codes: string[] }>('POST', BASE, {
      token, body: { draft: draft(2, { uid: '123', password: '', totp: 'bad8key', status: 'taken' }) },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.codes).toEqual(['fpInvalidUid', 'fpPasswordRequired', 'fpInvalidKey', 'fpHolderRequired']);
    const dup = await api<{ code: string }>('POST', BASE, { token, body: { draft: draft(1) } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('fpDuplicate');
    expect((await api('POST', BASE, { token, body: { draft: { uid: uid(3), status: 'nope' } } })).status).toBe(400);
    expect((await api('POST', BASE, { token, body: 'junk' })).status).toBe(400);
  });

  it('imports all rows or none, naming the rows that collide', async () => {
    const token = await manager();
    const snap = await seedPool(token, 3, 'Batch 2026-10');
    expect(snap.accounts.map((a) => a.no)).toEqual([1, 2, 3]);
    expect(snap.accounts.every((a) => a.batch === 'Batch 2026-10')).toBe(true);
    expect(snap.activity[0]).toMatchObject({ action: 'imported', detail: '3 · Batch 2026-10' });
    expect(snap.activity[0].accountNo).toBeUndefined();

    const clash = await api<{ code: string; failures: { index: number; uid: string; codes: string[] }[] }>(
      'POST', `${BASE}/import`, { token, body: { batch: 'B2', rows: [draft(4), draft(2), draft(5), draft(5)] } },
    );
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('fpDuplicate');
    expect(clash.body.failures).toEqual([
      { index: 1, uid: uid(2), codes: ['fpDuplicate'] },
      { index: 3, uid: uid(5), codes: ['fpDuplicate'] },
    ]);
    const after = await api<Snapshot>('GET', BASE, { token });
    expect(after.body.accounts).toHaveLength(3);
    expect((await api('POST', `${BASE}/import`, { token, body: { rows: [] } })).status).toBe(400);
  });

  it('edits keep cookie age and holding time when those did not change, and resolve a member by name', async () => {
    const token = await manager();
    const first = (await seedPool(token, 1)).accounts[0];
    const db = getTestDb();
    await db`UPDATE fb_pool_accounts SET cookie_at = NOW() - INTERVAL '10 days' WHERE no = 1`;

    const r = await api<Snapshot>('PUT', `${BASE}/1`, {
      token, body: { draft: draft(1, { note: 'edited', status: 'taken', holder: 'marcus wright' }) },
    });
    expect(r.status).toBe(200);
    const a = r.body.accounts[0];
    const marcus = (await loginAs(MARCUS)).user.id;
    expect(a).toMatchObject({ note: 'edited', status: 'taken', holder: 'marcus wright', holderId: marcus });
    expect(a.since).not.toBeNull();
    expect(first.cookieAt! - a.cookieAt!).toBeGreaterThan(9 * 86_400_000);

    // Same holder spelled the same way keeps its clock; a new cookie is fresh today.
    const r2 = await api<Snapshot>('PUT', `${BASE}/1`, {
      token, body: { draft: draft(1, { status: 'taken', holder: 'Marcus Wright', cookie: `c_user=${uid(1)}; xs=new` }) },
    });
    const b = r2.body.accounts[0];
    expect(b.since).toBe(a.since);
    expect(b.holderId).toBe(marcus);
    expect(Date.now() - b.cookieAt!).toBeLessThan(60_000);

    // A worker id is a holder with no member behind it; dropping the holder status clears both.
    const r3 = await api<Snapshot>('PUT', `${BASE}/1`, { token, body: { draft: draft(1, { status: 'fleet', holder: 'denver-1' }) } });
    expect(r3.body.accounts[0]).toMatchObject({ status: 'fleet', holder: 'denver-1', holderId: null });
    const r4 = await api<Snapshot>('PUT', `${BASE}/1`, { token, body: { draft: draft(1, { status: 'available', holder: 'denver-1' }) } });
    expect(r4.body.accounts[0]).toMatchObject({ status: 'available', holder: null, holderId: null, since: null });
    expect((await api('PUT', `${BASE}/99`, { token, body: { draft: draft(9) } })).status).toBe(404);

    const retired = await api<Snapshot>('POST', `${BASE}/1/retire`, { token });
    expect(retired.body.accounts[0]).toMatchObject({ status: 'retired', holder: null });
    expect(retired.body.activity[0]).toMatchObject({ action: 'retired', accountNo: 1 });
  });

  it('an edit without a token field keeps the stored token; an empty one clears it', async () => {
    const token = await manager();
    await seedPool(token, 1);
    const older: Record<string, unknown> = draft(1, { note: 'from an older bundle' });
    delete older.token;
    const kept = await api<Snapshot>('PUT', `${BASE}/1`, { token, body: { draft: older } });
    expect(kept.status).toBe(200);
    expect(kept.body.accounts[0]).toMatchObject({ note: 'from an older bundle', token: 'EAAtoken1' });

    const cleared = await api<Snapshot>('PUT', `${BASE}/1`, { token, body: { draft: draft(1, { token: '' }) } });
    expect(cleared.body.accounts[0].token).toBe('');
  });

  it('shows a purchaser the rack but only the logins they hold', async () => {
    const token = await manager();
    await seedPool(token, 3);
    await api('PUT', `${BASE}/3`, { token, body: { draft: draft(3, { cookie: 'xs=only; datr=d' }) } });
    const marcus = await loginAs(MARCUS);

    const before = await api<Snapshot>('GET', BASE, { token: marcus.token });
    expect(before.status).toBe(200);
    expect(before.body.activity).toEqual([]);
    for (const a of before.body.accounts) {
      expect(a.password).toBe('');
      expect(a.totp).toBe('');
      expect(a.emailPassword).toBe('');
      expect(a.recovery).toBe('');
      expect(a.token).toBe('');
      expect(a.cookie).not.toContain('xs=session');
    }
    expect(before.body.accounts[0].cookie).toBe(`c_user=${uid(1)}`);
    expect(before.body.accounts[0].cookieAt).not.toBeNull();
    expect(before.body.accounts[2].cookie).toBe('xs=redacted');
    expect(before.body.accounts.map((a) => a.uid)).toEqual([uid(1), uid(2), uid(3)]);

    const took = await api<Snapshot>('POST', `${BASE}/2/take`, { token: marcus.token });
    expect(took.status).toBe(200);
    const mine = took.body.accounts.find((a) => a.no === 2)!;
    expect(mine).toMatchObject({ status: 'taken', holder: 'Marcus Wright', holderId: marcus.user.id,
      password: 'DemoOnly!2', totp: 'JBSWY3DPEHPK3PXP', emailPassword: 'Mail!2', recovery: 'rec2@mail.example',
      token: 'EAAtoken2' });
    expect(mine.cookie).toContain('xs=session-2');
    expect(mine.since).not.toBeNull();
    expect(took.body.accounts.find((a) => a.no === 1)!.password).toBe('');

    // Another purchaser sees who holds #2 but none of its login.
    const priya = await api<Snapshot>('GET', BASE, { token: (await loginAs(PRIYA)).token });
    const theirs = priya.body.accounts.find((a) => a.no === 2)!;
    expect(theirs).toMatchObject({ status: 'taken', holder: 'Marcus Wright', password: '', totp: '' });

    // A manager previewing as a purchaser reads like one.
    const db = getTestDb();
    await db`UPDATE users SET preferences = jsonb_build_object('tweaks.rolePreview', 'as_purchaser') WHERE email = ${ALEX}`;
    const preview = await api<Snapshot>('GET', BASE, { token: (await loginAs(ALEX)).token });
    expect(preview.body.accounts.every((a) => a.password === '')).toBe(true);
    expect(preview.body.activity).toEqual([]);
  });

  it('caps a purchaser at the pool limit and settles two hands on one tag', async () => {
    const token = await manager();
    await seedPool(token, 4);
    const marcus = (await loginAs(MARCUS)).token;
    expect((await api('POST', `${BASE}/1/take`, { token: marcus })).status).toBe(200);
    expect((await api('POST', `${BASE}/2/take`, { token: marcus })).status).toBe(200);
    const third = await api<{ code: string }>('POST', `${BASE}/3/take`, { token: marcus });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('fpAtLimit');

    const priya = (await loginAs(PRIYA)).token;
    const again = await api<{ code: string }>('POST', `${BASE}/1/take`, { token: priya });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('fpTakenElsewhere');

    const [a, b] = await Promise.all([
      api('POST', `${BASE}/3/take`, { token: priya }),
      api('POST', `${BASE}/3/take`, { token: (await loginAs(ALEX)).token }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await api('POST', `${BASE}/99/take`, { token: priya })).status).toBe(404);
    expect((await api('POST', `${BASE}/abc/take`, { token: priya })).status).toBe(404);
  });

  it('lets the holder return or report, a manager too, and nobody else', async () => {
    const token = await manager();
    await seedPool(token, 2);
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    await api('POST', `${BASE}/1/take`, { token: marcus.token });
    await api('POST', `${BASE}/2/take`, { token: marcus.token });

    expect((await api('POST', `${BASE}/1/return`, { token: priya.token })).status).toBe(403);
    expect((await api('POST', `${BASE}/1/report`, { token: priya.token, body: { reason: 'disabled' } })).status).toBe(403);

    const returned = await api<Snapshot>('POST', `${BASE}/1/return`, { token: marcus.token });
    expect(returned.status).toBe(200);
    expect(returned.body.accounts[0]).toMatchObject({ status: 'available', holder: null, holderId: null, since: null, password: '' });
    const notTaken = await api<{ code: string }>('POST', `${BASE}/1/return`, { token: marcus.token });
    expect(notTaken.status).toBe(409);
    expect(notTaken.body.code).toBe('fpNotTaken');

    expect((await api('POST', `${BASE}/2/report`, { token: marcus.token, body: { reason: 'nope' } })).status).toBe(400);
    const reported = await api<Snapshot>('POST', `${BASE}/2/report`, {
      token: marcus.token, body: { reason: 'checkpoint', note: 'Checkpoint / ID check (Marcus Wright) · note 2' },
    });
    expect(reported.status).toBe(200);
    // The reporter stays on the row so a manager sees who hit it; the login is theirs no longer.
    expect(reported.body.accounts[1]).toMatchObject({ status: 'problem', holder: 'Marcus Wright',
      note: 'Checkpoint / ID check (Marcus Wright) · note 2', password: '' });
    expect(reported.body.accounts[1].since).not.toBeNull();

    const log = await api<Snapshot>('GET', BASE, { token });
    expect(log.body.activity.slice(0, 2)).toMatchObject([
      { who: 'Marcus Wright', action: 'reported', accountNo: 2, detail: 'checkpoint', status: 'problem' },
      { who: 'Marcus Wright', action: 'returned', accountNo: 1, status: 'available' },
    ]);

    // A manager can hand back a purchaser's account.
    await api('POST', `${BASE}/1/take`, { token: priya.token });
    expect((await api('POST', `${BASE}/1/return`, { token })).status).toBe(200);
  });

  it('records copies and reveals for the holder only, in an append-only ledger', async () => {
    const token = await manager();
    await seedPool(token, 1);
    const marcus = (await loginAs(MARCUS)).token;
    const priya = (await loginAs(PRIYA)).token;
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'copied', field: 'password' } })).status).toBe(403);
    await api('POST', `${BASE}/1/take`, { token: marcus });
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'copied', field: 'password' } })).status).toBe(200);
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'revealed', field: 'emailPassword' } })).status).toBe(200);
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'copied', field: 'token' } })).status).toBe(200);
    expect((await api('POST', `${BASE}/1/events`, { token: priya, body: { kind: 'copied', field: 'totp' } })).status).toBe(403);
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'edited', field: 'totp' } })).status).toBe(400);
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'copied', field: 'uid' } })).status).toBe(400);
    expect((await api('POST', `${BASE}/9/events`, { token: marcus, body: { kind: 'copied', field: 'totp' } })).status).toBe(404);

    const log = await api<Snapshot>('GET', BASE, { token });
    expect(log.body.activity.slice(0, 3).map((e) => [e.action, e.detail])).toEqual([
      ['copied', 'token'], ['revealed', 'emailPassword'], ['copied', 'password'],
    ]);

    const db = getTestDb();
    await expect(db`UPDATE fb_pool_events SET detail = 'x'`).rejects.toThrow(/append-only/);
    await expect(db`DELETE FROM fb_pool_events`).rejects.toThrow(/append-only/);
  });

  describe('sending a login to a fleet worker', () => {
    const ENV = { COORDINATOR_API_URL: 'http://facade.internal:8600', COORDINATOR_API_TOKEN: 'console-secret' };
    afterEach(() => { vi.unstubAllGlobals(); });

    // Assign reads the worker's proxy from the fleet document first. That read
    // is answered here, outside the spy, so `sent(spy, i)` counts only the
    // calls that act on the worker.
    let fleetAnswer: [number, unknown] = [200, { workers: [] }];
    // Each worker's login ledger as the console serves it, or the status it
    // fails with; null is a console from before the route.
    let ledger: Record<string, unknown[] | number> | null = {};
    beforeEach(() => { fleetAnswer = [200, { workers: [] }]; ledger = {}; });
    const PROXY = 'http://gw.proxy.example:10001';
    const onProxy = (...workers: [string, string | null][]) => {
      fleetAnswer = [200, { workers: workers.map(([worker_id, url]) => ({ worker_id, proxy: { url, ip: '203.0.113.7' } })) }];
    };

    function stubFacade(...answers: [number, unknown][]) {
      const spy = vi.fn(async (_url: string, _init?: RequestInit) => {
        const [status, body] = answers.length > 1 ? answers.shift()! : answers[0];
        return new Response(JSON.stringify(body), { status });
      });
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const u = new URL(String(url));
        if (u.pathname === '/v1/logins') {
          if (ledger === null) return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
          const rows = ledger[u.searchParams.get('worker_id') ?? ''] ?? [];
          return typeof rows === 'number'
            ? new Response(JSON.stringify({ detail: 'Coordinator answered 500' }), { status: rows })
            : new Response(JSON.stringify({ logins: rows }), { status: 200 });
        }
        if (u.pathname !== '/v1/fleet') return spy(url, init);
        const [status, body] = fleetAnswer;
        return new Response(JSON.stringify(body), { status });
      });
      return spy;
    }
    const sent = (spy: ReturnType<typeof vi.fn>, i: number) => {
      const [url, init] = spy.mock.calls[i] as [string, RequestInit];
      return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
    };

    it('seals the pool cookie as the worker’s session and restores it, no password login', async () => {
      const token = await manager();
      await seedPool(token, 2);
      await api('PUT', `${BASE}/2`, { token, body: { draft: draft(2, { totp: '', emailPassword: '' }) } });
      // The vault write, the session seed, then the restore.
      const spy = stubFacade([200, { account_id: 'nyc-1' }], [200, { status: 'ok' }], [200, { restore: 'requested' }]);

      const r = await api<Snapshot>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } });
      expect(r.status).toBe(200);
      // 1) the vault write still carries the device, and the password as the
      // fallback — never the session cookies.
      expect(sent(spy, 0)).toEqual({
        url: 'http://facade.internal:8600/v1/accounts/nyc-1',
        method: 'PUT',
        body: {
          worker_id: 'nyc-1',
          fb_username: 'acct1@outlook.example',
          fb_uid: uid(1),
          allow_password_login: true,
          secrets: { password: 'DemoOnly!1', totp_secret: 'JBSWY3DPEHPK3PXP', email: 'acct1@outlook.example', email_password: 'Mail!1', fb_token: 'EAAtoken1' },
          device_cookies: [expect.objectContaining({ name: 'datr', value: 'd', domain: '.facebook.com' })],
        },
      });
      expect(JSON.stringify(sent(spy, 0).body)).not.toContain('session-1');
      // 2) the whole cookie is sealed as the slot's session…
      expect(sent(spy, 1)).toEqual({
        url: 'http://facade.internal:8600/v1/workers/nyc-1/session',
        method: 'PUT',
        body: { cookie: `c_user=${uid(1)}; xs=session-1; datr=d`, reason: 'assign #1' },
      });
      // 3) …and restored at once, with no password Re-login.
      expect(sent(spy, 2)).toMatchObject({ url: 'http://facade.internal:8600/v1/workers/nyc-1/restore-session', method: 'POST' });
      expect(spy.mock.calls.some(([u]) => String(u).endsWith('/relogin'))).toBe(false);
      expect(r.body.accounts[0]).toMatchObject({ status: 'fleet', holder: 'nyc-1', holderId: null });
      expect(r.body.activity[0]).toMatchObject({ action: 'assigned', accountNo: 1, detail: 'nyc-1', status: 'fleet' });

      // A missing 2FA key or e-mail password clears the worker's old one; an
      // existing vault account is written under its own id.
      const spy2 = stubFacade([200, {}], [200, {}], [200, {}]);
      const r2 = await api('POST', `${BASE}/2/assign`, { token, env: ENV, body: { worker: 'va-1', account: 'personal' } });
      expect(r2.status).toBe(200);
      expect(sent(spy2, 0).url).toBe('http://facade.internal:8600/v1/accounts/personal');
      expect(sent(spy2, 0).body.secrets).toMatchObject({ totp_secret: null, email_password: null });
    });

    it('falls back to a password Re-login when the account has no usable cookie', async () => {
      const token = await manager();
      await seedPool(token, 1);
      // No cookie to restore (a mismatched one is dropped the same way), so the
      // worker signs in with the vault password instead.
      await api('PUT', `${BASE}/1`, { token, body: { draft: draft(1, { cookie: '' }) } });
      const spy = stubFacade([200, {}], [202, { queued: true }]);

      const r = await api<Snapshot>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } });
      expect(r.status).toBe(200);
      expect(sent(spy, 0)).toMatchObject({ url: 'http://facade.internal:8600/v1/accounts/nyc-1', method: 'PUT' });
      expect(sent(spy, 0).body.allow_password_login).toBe(true);
      // The token travels even in password mode — the worker's own refresh
      // before it ever types the password.
      expect(sent(spy, 0).body.secrets.fb_token).toBe('EAAtoken1');
      expect(sent(spy, 0).body).not.toHaveProperty('device_cookies'); // no cookie, no device
      expect(sent(spy, 1)).toMatchObject({ url: 'http://facade.internal:8600/v1/workers/nyc-1/relogin', method: 'POST' });
      expect(spy).toHaveBeenCalledTimes(2); // no seed, no restore
      expect(r.body.accounts[0]).toMatchObject({ status: 'fleet', holder: 'nyc-1' });
    });

    it('falls back to a password Re-login when the fleet will not seed the cookie', async () => {
      const token = await manager();
      await seedPool(token, 2);
      // A console older than the session route has no such path.
      const old = stubFacade([200, {}], [404, { detail: 'Not Found' }], [202, { queued: true }]);
      const r = await api<Snapshot>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } });
      expect(r.status).toBe(200);
      expect(sent(old, 1)).toMatchObject({ url: 'http://facade.internal:8600/v1/workers/nyc-1/session', method: 'PUT' });
      expect(sent(old, 2)).toMatchObject({ url: 'http://facade.internal:8600/v1/workers/nyc-1/relogin', method: 'POST' });
      expect(old).toHaveBeenCalledTimes(3); // no restore
      expect(r.body.accounts[0]).toMatchObject({ status: 'fleet', holder: 'nyc-1' });

      // A cookie the coordinator refuses (no xs) goes the same way.
      const refused = stubFacade([200, {}], [422, { detail: 'The cookie is missing xs' }], [202, { queued: true }]);
      const r2 = await api<Snapshot>('POST', `${BASE}/2/assign`, { token, env: ENV, body: { worker: 'va-1' } });
      expect(r2.status).toBe(200);
      expect(sent(refused, 2).url).toBe('http://facade.internal:8600/v1/workers/va-1/relogin');
      expect(r2.body.accounts.find((a) => a.no === 2)).toMatchObject({ status: 'fleet', holder: 'va-1' });
    });

    it('changes nothing when the Re-login after a refused seed fails', async () => {
      const token = await manager();
      await seedPool(token, 1);
      stubFacade([200, {}], [404, { detail: 'Not Found' }], [404, { detail: "Unknown worker 'nyc-1'" }]);
      const r = await api<{ error: string }>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } });
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/reached nyc-1, but Re-login was not queued: Unknown worker/);
      const after = await api<Snapshot>('GET', BASE, { token });
      expect(after.body.accounts[0].status).toBe('available');
      expect(after.body.activity.some((e) => e.action === 'assigned')).toBe(false);
    });

    it('changes nothing when the facade refuses, and says why', async () => {
      const token = await manager();
      await seedPool(token, 1);
      stubFacade([409, { detail: "worker nyc-1 already belongs to account 'other'" }]);
      const r = await api<{ error: string }>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/already belongs/);
      const after = await api<Snapshot>('GET', BASE, { token });
      expect(after.body.accounts[0].status).toBe('available');
      expect(after.body.activity.some((e) => e.action === 'assigned')).toBe(false);

      // Cookie-first: the second call is the session seed, the third the restore.
      stubFacade([200, {}], [503, { detail: 'Coordinator upstream is not configured' }]);
      const half = await api<{ error: string }>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } });
      expect(half.status).toBe(503);
      expect(half.body.error).toMatch(/reached nyc-1, but its session was not seeded/);

      stubFacade([200, {}], [200, {}], [502, { detail: 'coordinator unreachable' }]);
      const r3 = await api<{ error: string }>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } });
      expect(r3.status).toBe(502);
      expect(r3.body.error).toMatch(/seeded on nyc-1, but the restore was not queued/);
    });

    it('refuses a worker that already holds another account, a bad id, and purchasers', async () => {
      const token = await manager();
      await seedPool(token, 2);
      await api('PUT', `${BASE}/2`, { token, body: { draft: draft(2, { status: 'fleet', holder: 'nyc-1' }) } });
      const spy = stubFacade([200, {}]);
      const taken = await api<{ code: string }>('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'NYC-1' } });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('fpWorkerTaken');
      // An account already on another worker is not handed out again.
      const held = await api<{ code: string }>('POST', `${BASE}/2/assign`, { token, env: ENV, body: { worker: 'va-1' } });
      expect(held.status).toBe(409);
      expect(held.body.code).toBe('fpAssignHeld');
      expect((await api('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'a.b' } })).status).toBe(400);
      expect((await api('POST', `${BASE}/9/assign`, { token, env: ENV, body: { worker: 'va-1' } })).status).toBe(404);
      const marcus = (await loginAs(MARCUS)).token;
      expect((await api('POST', `${BASE}/1/assign`, { token: marcus, env: ENV, body: { worker: 'va-1' } })).status).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });

    type Stint = { accountNo: number; uid: string; email: string | null; proxyUrl: string | null; proxyKnown: boolean;
      startedAt: number; endedAt: number | null; outcome: string | null };
    type Mark = { url: string; failed: number; dead: boolean; deadAt: number | null; revivedAt: number | null; revivedBy: string | null };
    const stints = async (token: string, worker: string) =>
      (await api<{ stints: Stint[] }>('GET', `${BASE}/workers/${worker}/accounts`, { token })).body.stints;
    const marks = async (token: string) => (await api<{ proxies: Mark[] }>('GET', `${BASE}/proxies`, { token })).body.proxies;
    const assign = (token: string, no: number, worker: string, previous?: string) =>
      api<{ code?: string; error?: string }>('POST', `${BASE}/${no}/assign`, { token, env: ENV, body: { worker, previous } });

    it('keeps every account a worker used, with the proxy it went out through and how it ended', async () => {
      const token = await manager();
      await seedPool(token, 5);
      onProxy(['nyc-1', PROXY], ['va-1', null]);
      stubFacade([200, {}]);
      expect((await assign(token, 1, 'nyc-1')).status).toBe(200);
      expect((await assign(token, 2, 'nyc-1', 'problem')).status).toBe(200);
      expect((await assign(token, 3, 'nyc-1', 'available')).status).toBe(200);
      // Sending the same login again continues its stint.
      expect((await assign(token, 3, 'nyc-1')).status).toBe(200);
      expect((await assign(token, 4, 'va-1')).status).toBe(200);

      const nyc = await stints(token, 'NYC-1');
      expect(nyc.map((s) => [s.accountNo, s.outcome, s.proxyUrl])).toEqual([
        [3, null, PROXY], [2, 'available', PROXY], [1, 'problem', PROXY],
      ]);
      expect(nyc[2]).toMatchObject({ uid: uid(1), email: 'acct1@outlook.example', proxyKnown: true });
      expect(nyc[2].endedAt).not.toBeNull();
      // The VM's own IP is a known proxy of none.
      expect(await stints(token, 'va-1')).toMatchObject([{ accountNo: 4, proxyUrl: null, proxyKnown: true, outcome: null }]);

      // Every other way off a worker closes the stint too: the weekly check's
      // move to Problem (holder kept), a delete, an edit to another worker.
      await getTestDb()`UPDATE fb_pool_accounts SET status = 'problem', updated_at = NOW() WHERE no = 3`;
      expect((await api('DELETE', `${BASE}/4`, { token })).status).toBe(200);
      await api('PUT', `${BASE}/5`, { token, body: { draft: draft(5, { status: 'fleet', holder: 'nyc-1' }) } });
      await api('PUT', `${BASE}/5`, { token, body: { draft: draft(5, { status: 'fleet', holder: 'va-1' }) } });
      expect((await stints(token, 'nyc-1')).map((s) => [s.accountNo, s.outcome, s.proxyKnown])).toEqual([
        [5, 'fleet', false], [3, 'problem', true], [2, 'available', true], [1, 'problem', true],
      ]);
      expect((await stints(token, 'va-1')).map((s) => [s.accountNo, s.outcome])).toEqual([[5, null], [4, 'removed']]);

      // Two failed on the proxy, the returned one doesn't count.
      expect(await marks(token)).toEqual([
        { url: PROXY, failed: 2, dead: false, deadAt: null, revivedAt: null, revivedBy: null },
      ]);
    });

    it('marks a proxy DEAD at its fifth failed account and refuses Assign behind it until revived', async () => {
      const token = await manager();
      await seedPool(token, 8);
      // Two workers dial one proxy: its failures are the proxy's, not a worker's.
      onProxy(['nyc-1', PROXY], ['nyc-2', PROXY]);
      const spy = stubFacade([200, {}]);
      expect((await assign(token, 1, 'nyc-1')).status).toBe(200);
      for (const no of [2, 3, 4]) expect((await assign(token, no, 'nyc-1', 'problem')).status).toBe(200);
      expect((await assign(token, 5, 'nyc-2')).status).toBe(200);
      expect((await assign(token, 6, 'nyc-2', 'retired')).status).toBe(200);
      // #1-#3 failed on nyc-1, #5 on nyc-2: four is not yet more than four.
      expect(await marks(token)).toMatchObject([{ url: PROXY, failed: 4, dead: false, deadAt: null }]);

      expect((await assign(token, 7, 'nyc-1', 'problem')).status).toBe(200);
      const [dead] = await marks(token);
      expect(dead).toMatchObject({ url: PROXY, failed: 5, dead: true });
      expect(dead.deadAt).not.toBeNull();

      const calls = spy.mock.calls.length;
      for (const worker of ['nyc-1', 'nyc-2']) {
        const refused = await assign(token, 8, worker, 'problem');
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('fpProxyDead');
        expect(refused.body.error).toMatch(/DEAD: 5 accounts failed/);
      }
      // Unreadable, the fleet document leaves the check to the proxy the
      // worker's last account went through.
      fleetAnswer = [502, { detail: 'coordinator unreachable' }];
      expect((await assign(token, 8, 'nyc-1', 'problem')).body.code).toBe('fpProxyDead');
      onProxy(['nyc-1', PROXY], ['nyc-2', PROXY]);
      expect(spy.mock.calls.length).toBe(calls); // nothing reached a worker
      const pool = await api<Snapshot>('GET', BASE, { token });
      expect(pool.body.accounts.find((a) => a.no === 8)).toMatchObject({ status: 'available' });
      expect(pool.body.accounts.find((a) => a.no === 7)).toMatchObject({ status: 'fleet', holder: 'nyc-1' });

      // A revive restarts the count; failures after it count again.
      const marcus = (await loginAs(MARCUS)).token;
      expect((await api('POST', `${BASE}/proxies/revive`, { token: marcus, body: { url: PROXY } })).status).toBe(403);
      expect((await api('GET', `${BASE}/proxies`, { token: marcus })).status).toBe(403);
      expect((await api('POST', `${BASE}/proxies/revive`, { token, body: { url: '' } })).status).toBe(400);
      const revived = await api<{ proxies: Mark[] }>('POST', `${BASE}/proxies/revive`, { token, body: { url: PROXY } });
      expect(revived.status).toBe(200);
      expect(revived.body.proxies).toEqual([]);
      expect((await assign(token, 8, 'nyc-1', 'problem')).status).toBe(200);
      expect(await marks(token)).toMatchObject([{ url: PROXY, failed: 1, dead: false, revivedBy: 'Alex Chen' }]);
    });

    type TimelineEvent = { kind: string; at: number; worker?: string; trigger?: string | null; outcome?: string | null;
      detail?: string | null; url?: string | null; action?: string; by?: string; batch?: string };
    const timeline = (token: string, no: number) =>
      api<{ events: TimelineEvent[]; logins: string }>('GET', `${BASE}/${no}/timeline`, { token, env: ENV });
    const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00');
    const attempt = (worker: string, at: number, over: Record<string, unknown> = {}) => ({
      id: at, worker_id: worker, account_id: worker, identity_key: null, trigger: 'boot', outcome: 'restored',
      started_at: iso(at), finished_at: iso(at + 5000), detail: null, ...over,
    });

    it('traces an account across workers: its logins and the pool events, newest first', async () => {
      const token = await manager();
      await seedPool(token, 2);
      onProxy(['ne-1', PROXY], ['va-1', null]);
      stubFacade([200, {}]);
      expect((await assign(token, 1, 'ne-1')).status).toBe(200);
      expect((await assign(token, 2, 'ne-1', 'problem')).status).toBe(200);
      expect((await assign(token, 1, 'va-1')).status).toBe(200);
      const [on2, on1] = await stints(token, 'ne-1');
      const [onVa] = await stints(token, 'va-1');

      ledger = {
        'ne-1': [
          attempt('ne-1', on1.startedAt, { trigger: 'cookie-restore' }), // unnamed, inside #1's stint
          attempt('ne-1', on1.startedAt - 86_400_000, { identity_key: `uid:${uid(1)}`, trigger: 'relogin', outcome: 'password_ok' }),
          attempt('ne-1', on2.startedAt + 60_000, { outcome: 'failed' }), // unnamed, #2's time
          attempt('ne-1', on2.startedAt + 120_000, { identity_key: `uid:${uid(2)}` }), // named #2
        ],
        'va-1': [attempt('va-1', onVa.startedAt + 1000, {
          trigger: 'relogin', outcome: 'challenge',
          detail: { kind: 'checkpoint', url: 'https://www.facebook.com/checkpoint/1/' },
        })],
      };
      const r = await timeline(token, 1);
      expect(r.status).toBe(200);
      expect(r.body.logins).toBe('ok');
      const logins = r.body.events.filter((e) => e.kind === 'login');
      expect(logins.map((e) => [e.worker, e.trigger, e.outcome, e.detail])).toEqual([
        ['va-1', 'relogin', 'challenge', 'checkpoint'],
        ['ne-1', 'cookie-restore', 'restored', null],
        ['ne-1', 'relogin', 'password_ok', null],
      ]);
      expect(logins[0].url).toBe('https://www.facebook.com/checkpoint/1/');
      const pool = r.body.events.filter((e) => e.kind !== 'login');
      expect(pool.map((e) => [e.kind, e.action ?? null, e.detail ?? null])).toEqual([
        ['pool', 'assigned', 'va-1'],
        ['pool', 'reported', 'replaced by #2 on ne-1'],
        ['pool', 'assigned', 'ne-1'],
        ['added', null, null],
      ]);
      expect(pool[0].by).toBe('Alex Chen');
      expect(pool[3].batch).toBe('Batch T');
      const ats = r.body.events.map((e) => e.at);
      expect(ats).toEqual([...ats].sort((a, b) => b - a));

      // #2 gets its own rows and none of #1's.
      const two = await timeline(token, 2);
      expect(two.body.events.filter((e) => e.kind === 'login').map((e) => e.outcome)).toEqual(['restored', 'failed']);

      const marcus = (await loginAs(MARCUS)).token;
      expect((await timeline(marcus, 1)).status).toBe(403);
      expect((await timeline(token, 99)).status).toBe(404);
    });

    it('still shows the pool events when the console does not serve logins', async () => {
      const token = await manager();
      await seedPool(token, 1);
      onProxy(['ne-1', PROXY]);
      stubFacade([200, {}]);
      expect((await assign(token, 1, 'ne-1')).status).toBe(200);
      ledger = null;
      const r = await timeline(token, 1);
      expect(r.status).toBe(200);
      expect(r.body.logins).toBe('not_served');
      expect(r.body.events.map((e) => e.kind)).toEqual(['pool', 'added']);
    });

    it('marks logins partial when one worker does not answer or its ledger stops short', async () => {
      const token = await manager();
      await seedPool(token, 2);
      onProxy(['ne-1', PROXY], ['va-1', null]);
      stubFacade([200, {}]);
      expect((await assign(token, 1, 'ne-1')).status).toBe(200);
      expect((await assign(token, 2, 'ne-1', 'problem')).status).toBe(200);
      expect((await assign(token, 1, 'va-1')).status).toBe(200);
      const [, onNe] = await stints(token, 'ne-1');
      const [onVa] = await stints(token, 'va-1');

      ledger = { 'ne-1': [attempt('ne-1', onNe.startedAt, { identity_key: `uid:${uid(1)}` })], 'va-1': 500 };
      const r = await timeline(token, 1);
      expect(r.status).toBe(200);
      expect(r.body.logins).toBe('partial');
      expect(r.body.events.filter((e) => e.kind === 'login').map((e) => e.worker)).toEqual(['ne-1']);

      ledger = { 'ne-1': 500, 'va-1': 500 };
      expect((await timeline(token, 1)).body.logins).toBe('unreachable');

      // A full page that begins after the account went on va-1.
      const page = Array.from({ length: 500 }, (_, i) => attempt('va-1', onVa.startedAt + 60_000 + i));
      ledger = { 'ne-1': [], 'va-1': page };
      expect((await timeline(token, 1)).body.logins).toBe('partial');
      ledger = { 'ne-1': [], 'va-1': page.slice(1) };
      expect((await timeline(token, 1)).body.logins).toBe('ok');
    });

    it('assigns with the proxy unknown when the fleet document cannot be read', async () => {
      const token = await manager();
      await seedPool(token, 1);
      fleetAnswer = [502, { detail: 'coordinator unreachable' }];
      const spy = stubFacade([200, {}]);
      const r = await assign(token, 1, 'nyc-1');
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      expect(await stints(token, 'nyc-1')).toMatchObject([{ proxyUrl: null, proxyKnown: false }]);
    });

    it('sends no device when the pool cookie belongs to another account, or has none', async () => {
      const token = await manager();
      await seedPool(token, 2);
      // A cookie pasted for the wrong account must not lend it a device.
      await api('PUT', `${BASE}/1`, { token, body: { draft: draft(1, { cookie: `c_user=${uid(9)}; datr=other` }) } });
      await api('PUT', `${BASE}/2`, { token, body: { draft: draft(2, { cookie: `c_user=${uid(2)}; xs=s` }) } });
      const spy = stubFacade([200, {}], [202, {}], [200, {}], [202, {}]);
      expect((await api('POST', `${BASE}/1/assign`, { token, env: ENV, body: { worker: 'nyc-1' } })).status).toBe(200);
      expect((await api('POST', `${BASE}/2/assign`, { token, env: ENV, body: { worker: 'va-1' } })).status).toBe(200);
      expect(sent(spy, 0).body).not.toHaveProperty('device_cookies');
      expect(sent(spy, 2).body).not.toHaveProperty('device_cookies');
    });

    it('moves the account a worker held to the status the caller names', async () => {
      const token = await manager();
      await seedPool(token, 3);
      await api('PUT', `${BASE}/1`, { token, body: { draft: draft(1, { status: 'fleet', holder: 'nyc-1' }) } });
      expect((await api('POST', `${BASE}/2/assign`, {
        token, env: ENV, body: { worker: 'nyc-1', previous: 'taken' },
      })).status).toBe(400);

      stubFacade([200, {}], [202, {}]);
      const r = await api<Snapshot>('POST', `${BASE}/2/assign`, {
        token, env: ENV, body: { worker: 'nyc-1', previous: 'problem' },
      });
      expect(r.status).toBe(200);
      const byNo = new Map(r.body.accounts.map((a) => [a.no, a]));
      expect(byNo.get(2)).toMatchObject({ status: 'fleet', holder: 'nyc-1' });
      // A problem account keeps naming the worker it failed on.
      expect(byNo.get(1)).toMatchObject({ status: 'problem', holder: 'nyc-1' });
      // Both lines share the transaction's NOW(), so their order is not fixed.
      expect(r.body.activity.slice(0, 2)).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'reported', accountNo: 1, detail: 'replaced by #2 on nyc-1' }),
        expect.objectContaining({ action: 'assigned', accountNo: 2, detail: 'nyc-1' }),
      ]));

      stubFacade([200, {}], [202, {}]);
      const back = await api<Snapshot>('POST', `${BASE}/3/assign`, {
        token, env: ENV, body: { worker: 'nyc-1', previous: 'available' },
      });
      expect(back.status).toBe(200);
      expect(back.body.accounts.find((a) => a.no === 2)).toMatchObject({ status: 'available', holder: null, since: null });
      expect(back.body.accounts.find((a) => a.no === 1)).toMatchObject({ status: 'problem' });
    });
  });

  it('keeps the manager routes from purchasers and refuses everything without a key in production', async () => {
    const token = await manager();
    await seedPool(token, 1);
    const marcus = (await loginAs(MARCUS)).token;
    for (const [method, path, body] of [
      ['POST', BASE, { draft: draft(5) }],
      ['PUT', `${BASE}/1`, { draft: draft(1) }],
      ['POST', `${BASE}/1/retire`, undefined],
      ['DELETE', `${BASE}/1`, undefined],
      ['POST', `${BASE}/import`, { rows: [draft(5)] }],
    ] as const) {
      const r = await api(method, path, { token: marcus, body });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect((await api('GET', BASE, {})).status).toBe(401);

    const prod = await api<{ error: string }>('GET', BASE, { token, env: { NODE_ENV: 'production' } });
    expect(prod.status).toBe(503);
    expect(prod.body.error).toMatch(/FB_POOL_KEY/);
    const keyed = await api<Snapshot>('GET', BASE, {
      token, env: { NODE_ENV: 'production', FB_POOL_KEY: '00'.repeat(32) },
    });
    // A different key cannot open the stored blobs: that surfaces, never silently reads as blank.
    expect(keyed.status).toBe(500);
  });
});
