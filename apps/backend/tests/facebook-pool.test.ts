import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

type Account = {
  no: number; uid: string; password: string; totp: string; email: string; emailPassword: string;
  recovery: string; cookie: string; note: string; status: string; holder: string | null;
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
      emailPassword: 'Mail!1', recovery: 'rec1@mail.example', status: 'available', holder: null, batch: 'By hand' });
    expect(a.cookie).toContain('xs=session-1');
    expect(a.cookieAt).not.toBeNull();
    expect(r.body.activity[0]).toMatchObject({ who: 'Alex Chen', action: 'added', accountNo: 1, status: 'available' });

    const db = getTestDb();
    const [row] = await db<{ password_enc: string; cookie_enc: string; cookie_uid: string }[]>`
      SELECT password_enc, cookie_enc, cookie_uid FROM fb_pool_accounts WHERE no = 1`;
    expect(row.password_enc.startsWith('v1.')).toBe(true);
    expect(row.password_enc).not.toContain('DemoOnly');
    expect(row.cookie_enc).not.toContain('session-1');
    expect(row.cookie_uid).toBe(uid(1));

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
      password: 'DemoOnly!2', totp: 'JBSWY3DPEHPK3PXP', emailPassword: 'Mail!2', recovery: 'rec2@mail.example' });
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
    expect((await api('POST', `${BASE}/1/events`, { token: priya, body: { kind: 'copied', field: 'totp' } })).status).toBe(403);
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'edited', field: 'totp' } })).status).toBe(400);
    expect((await api('POST', `${BASE}/1/events`, { token: marcus, body: { kind: 'copied', field: 'uid' } })).status).toBe(400);
    expect((await api('POST', `${BASE}/9/events`, { token: marcus, body: { kind: 'copied', field: 'totp' } })).status).toBe(404);

    const log = await api<Snapshot>('GET', BASE, { token });
    expect(log.body.activity.slice(0, 2).map((e) => [e.action, e.detail])).toEqual([
      ['revealed', 'emailPassword'], ['copied', 'password'],
    ]);

    const db = getTestDb();
    await expect(db`UPDATE fb_pool_events SET detail = 'x'`).rejects.toThrow(/append-only/);
    await expect(db`DELETE FROM fb_pool_events`).rejects.toThrow(/append-only/);
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
