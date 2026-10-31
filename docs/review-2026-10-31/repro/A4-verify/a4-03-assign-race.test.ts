// A4-03 repro: POST /facebook-pool/:no/assign checks the row unlocked, sends
// the login to the worker over the facade, then UPDATEs the row with no status
// guard. Asserts the SAFE behaviour, so failing tests reproduce the claim.
// The facade is a stubbed fetch; no real worker or Facebook is involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, resetDb } from '../../../../apps/backend/tests/helpers/db';
import { api } from '../../../../apps/backend/tests/helpers/app';
import { ALEX, MARCUS, SOFIA, loginAs } from '../../../../apps/backend/tests/helpers/auth';

const BASE = '/api/facebook-pool';
const ENV = { COORDINATOR_API_URL: 'http://facade.internal:8600', COORDINATOR_API_TOKEN: 'console-secret' };
const uid = (n: number) => String(61556203481000 + n);
// No cookie: the password path (vault write + relogin), the one that queues a Facebook login.
const draft = (n: number) => ({ uid: uid(n), password: `DemoOnly!${n}`, totp: '', email: '', emailPassword: '',
  recovery: '', cookie: '', token: '', note: '', status: 'available', holder: null });

describe('A4-03 assign races', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('(b) a purchaser Take that lands while the login is in flight is not silently flipped to fleet', async () => {
    const mgr = (await loginAs(ALEX)).token;
    const marcus = (await loginAs(MARCUS)).token;
    expect((await api('POST', `${BASE}/import`, { token: mgr, body: { batch: 'T', rows: [draft(1)] } })).status).toBeLessThan(300);
    const calls: string[] = [];
    let took = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
      if (u.pathname === '/v1/fleet') return new Response(JSON.stringify({ workers: [] }), { status: 200 });
      if (u.pathname.startsWith('/v1/accounts/')) {
        // The purchaser presses Take while the vault write is in flight.
        took = (await api('POST', `${BASE}/1/take`, { token: marcus, body: {} })).status;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const r = await api<any>('POST', `${BASE}/1/assign`, { token: mgr, env: ENV, body: { worker: 'nyc-1' } });
    const [row] = await getTestDb()<{ status: string; holder_name: string }[]>`SELECT status, holder_name FROM fb_pool_accounts WHERE no = 1`;
    console.log('A4-03(b) take status:', took, '| assign status:', r.status, '| facade calls:', calls.join(', '), '| row:', JSON.stringify(row));
    expect(took).toBe(200);
    expect(row.status).toBe('taken');
  });

  it('(a) two managers assigning one account to two workers at once send the login to only one', async () => {
    const alex = (await loginAs(ALEX)).token;
    const sofia = (await loginAs(SOFIA)).token;
    expect((await api('POST', `${BASE}/import`, { token: alex, body: { batch: 'T', rows: [draft(1)] } })).status).toBeLessThan(300);
    const relogins: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/v1/fleet') return new Response(JSON.stringify({ workers: [] }), { status: 200 });
      if (u.pathname.endsWith('/relogin')) relogins.push(u.pathname);
      await new Promise((res) => setTimeout(res, 50));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const [r1, r2] = await Promise.all([
      api<any>('POST', `${BASE}/1/assign`, { token: alex, env: ENV, body: { worker: 'rs-ne-1' } }),
      api<any>('POST', `${BASE}/1/assign`, { token: sofia, env: ENV, body: { worker: 'rs-ca-3' } }),
    ]);
    const [row] = await getTestDb()<{ status: string; holder_name: string }[]>`SELECT status, holder_name FROM fb_pool_accounts WHERE no = 1`;
    console.log('A4-03(a) statuses:', r1.status, r2.status, '| relogins queued:', relogins.join(', '), '| row:', JSON.stringify(row));
    expect(relogins.length).toBe(1);
  });
});
