import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import type { PoolAccountSummary } from '@recycle-erp/shared';

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

const SECRET_KEYS = ['password', 'totp', 'emailPassword', 'recovery', 'cookie', 'token'];
const SECRET_VALUES = ['DemoOnly!', 'Mail!', 'rec1@', 'xs=session', 'EAAtoken', 'JBSWY3DPEHPK3PXP'];

describe('facebook pool summary', () => {
  beforeEach(async () => { await resetDb(); });

  async function seed() {
    const token = (await loginAs(ALEX)).token;
    const r = await api('POST', `${BASE}/import`, {
      token,
      body: { batch: 'Batch S', rows: [draft(3), draft(1), draft(2, { cookie: '' })] },
    });
    expect(r.status).toBe(201);
    return token;
  }

  it('answers every row in pool order with no secret field or value', async () => {
    const token = await seed();
    const r = await api<{ accounts: PoolAccountSummary[] }>('GET', `${BASE}/summary`, { token });
    expect(r.status).toBe(200);
    expect(r.body.accounts.map((a) => a.no)).toEqual([1, 2, 3]);
    for (const a of r.body.accounts) {
      for (const k of SECRET_KEYS) expect(a).not.toHaveProperty(k);
    }
    const text = JSON.stringify(r.body);
    for (const v of SECRET_VALUES) expect(text).not.toContain(v);
    expect(r.body.accounts[0]).toMatchObject({
      uid: uid(3), email: 'acct3@outlook.example', note: 'note 3', status: 'available',
      holder: null, holderId: null, batch: 'Batch S',
    });
  });

  it('says whether a row has a cookie and gives its c_user only then', async () => {
    const token = await seed();
    const r = await api<{ accounts: PoolAccountSummary[] }>('GET', `${BASE}/summary`, { token });
    const byUid = new Map(r.body.accounts.map((a) => [a.uid, a]));
    expect(byUid.get(uid(1))).toMatchObject({ hasCookie: true, cookieUid: uid(1) });
    expect(byUid.get(uid(2))).toMatchObject({ hasCookie: false, cookieUid: null, cookieAt: null });

    // A cookie saved without a c_user still counts as a cookie.
    await getTestDb()`UPDATE fb_pool_accounts SET cookie_uid = NULL WHERE uid = ${uid(3)}`;
    const again = await api<{ accounts: PoolAccountSummary[] }>('GET', `${BASE}/summary`, { token });
    expect(again.body.accounts.find((a) => a.uid === uid(3))).toMatchObject({ hasCookie: true, cookieUid: null });
  });

  it('gives a purchaser the same answer as a manager, and nothing when signed out', async () => {
    const managerToken = await seed();
    const asManager = await api<{ accounts: PoolAccountSummary[] }>('GET', `${BASE}/summary`, { token: managerToken });
    const asPurchaser = await api<{ accounts: PoolAccountSummary[] }>('GET', `${BASE}/summary`, {
      token: (await loginAs(MARCUS)).token,
    });
    expect(asPurchaser.status).toBe(200);
    expect(asPurchaser.body).toEqual(asManager.body);
    expect((await api('GET', `${BASE}/summary`)).status).toBe(401);
  });
});
