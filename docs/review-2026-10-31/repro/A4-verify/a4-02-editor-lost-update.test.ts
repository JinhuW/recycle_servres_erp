// A4-02 repro: a manager's pool-editor save, built from a snapshot loaded
// before a fleet worker resealed its session, writes the stale session back.
// Asserts the SAFE behaviour (worker's newer session survives), so a failing
// test reproduces the claim. Made-up material only.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getTestDb, resetDb } from '../../../../apps/backend/tests/helpers/db';
import { api, testEnv } from '../../../../apps/backend/tests/helpers/app';
import { ALEX, loginAs } from '../../../../apps/backend/tests/helpers/auth';
import { sha256hex } from '../../../../apps/backend/src/fleet/sql';
import { poolKey, seal, unseal } from '../../../../apps/backend/src/lib/sealed';

const HOST = 'host-' + randomBytes(8).toString('hex');
const UID = '61550000000077';

describe('A4-02 pool editor vs worker session save', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager save of an unrelated field does not overwrite a newer worker-saved session', async () => {
    const db = getTestDb();
    const k = poolKey(testEnv)!;
    await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST)}, 2, TRUE)`;
    await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["server ram"]')`;
    const [a] = await db<{ no: number }[]>`
      INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, cookie_enc, cookie_uid)
      VALUES (${UID}, 'fixtures', 'fleet', 'lab-1', ${seal('pw', k)}, ${seal(`c_user=${UID}; xs=S1-old`, k)}, ${UID}) RETURNING no`;
    await db`INSERT INTO fleet_slots (account_no, last_host_id) VALUES (${a.no}, 'lab')`;
    const claim = await api<any>('POST', '/api/fleet/worker/claim', {
      headers: { Authorization: `Bearer ${HOST}` }, body: { host_id: 'lab', worker_id: 'lab-1', version: '0.15.0', vnc_port: 5901 } });
    expect(claim.status).toBe(200);

    // 1. Manager opens the Accounts page.
    const mgr = (await loginAs(ALEX)).token;
    const snap = await api<any>('GET', '/api/facebook-pool', { token: mgr });
    const acct = snap.body.accounts.find((x: any) => x.no === a.no);
    console.log('A4-02 snapshot cookie:', acct.cookie);

    // 2. The worker reseals its rotated session S2.
    const s2 = claim.body.account.cookies.map((c: any) => c.name === 'xs' ? { ...c, value: 'S2-rotated' } : c);
    const put = await api('PUT', '/api/fleet/worker/session', { headers: { Authorization: `Bearer ${claim.body.worker_token}` }, body: { cookies: s2 } });
    expect(put.status).toBe(200);
    const mid = unseal((await db<{ cookie_enc: string }[]>`SELECT cookie_enc FROM fb_pool_accounts WHERE no = ${a.no}`)[0].cookie_enc, k);
    console.log('A4-02 stored after worker save:', mid);

    // 3. Manager edits the note in the editor, which was seeded from the snapshot.
    const draft = { uid: acct.uid, password: acct.password ?? 'pw', totp: acct.totp ?? '', email: acct.email ?? '',
      emailPassword: acct.emailPassword ?? '', recovery: acct.recovery ?? '', cookie: acct.cookie, token: acct.token ?? '',
      note: 'edited note', status: acct.status, holder: acct.holder };
    const save = await api<any>('PUT', `/api/facebook-pool/${a.no}`, { token: mgr, body: { draft } });
    console.log('A4-02 manager save status:', save.status, JSON.stringify(save.body?.error ?? save.body?.codes ?? ''));
    const [row] = await db<{ cookie_enc: string; cookie_by: string }[]>`SELECT cookie_enc, cookie_by FROM fb_pool_accounts WHERE no = ${a.no}`;
    const after = unseal(row.cookie_enc, k);
    console.log('A4-02 stored after manager save:', after, '| cookie_by:', row.cookie_by);

    expect(after).toContain('S2-rotated');
  });
});
