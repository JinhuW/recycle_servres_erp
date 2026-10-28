import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getTestDb, resetDb, TEST_DATABASE_URL } from './helpers/db';
import { testEnv } from './helpers/app';
import { listProxies } from '../src/fleet/proxies';
import { poolKey, seal, unseal } from '../src/lib/sealed';

// fleet-link-proxies.mjs: seeded slots carry a proxy URL but no proxy_id, so
// the list and the per-proxy limit never counted them. Every proxy, login and
// account here is made up.

const backendRoot = join(import.meta.dirname, '..');
const LOGIN = 'decodo-user-' + randomBytes(4).toString('hex');
const SECRET = 'pw-' + randomBytes(8).toString('hex');
const url = (port: number) => `http://${LOGIN}:${SECRET}@isp.example.net:${port}`;
const key = () => poolKey(testEnv)!;

function link(extra: string[] = []) {
  const r = spawnSync('node', [join(backendRoot, 'scripts', 'fleet-link-proxies.mjs'), ...extra], {
    // The child derives the same pool key from the same JWT_SECRET.
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, JWT_SECRET: testEnv.JWT_SECRET, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout + r.stderr).not.toContain(LOGIN);
  expect(r.stdout + r.stderr).not.toContain(SECRET);
  return r.stdout;
}

async function seededSlot(n: number, port: number, timezone = 'America/Chicago'): Promise<number> {
  const db = getTestDb();
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name) VALUES (${`6157000000000${n}`}, 'fixtures', 'fleet', ${`homelab-${n}`})
    RETURNING no`;
  await db`INSERT INTO fleet_slots (account_no, proxy_url, device)
           VALUES (${a.no}, ${seal(url(port), key())}, ${db.json({ user_agent: 'ua', viewport: [1280, 800], timezone })})`;
  return a.no;
}

const proxyIds = async () =>
  (await getTestDb()<{ account_no: number; proxy_id: number | null }[]>`SELECT account_no, proxy_id FROM fleet_slots ORDER BY account_no`);

describe('fleet-link-proxies.mjs', () => {
  beforeEach(async () => { await resetDb(); });

  it('links seeded slots to the list, making the exits it lacks and the coordinator ports it holds a login for', async () => {
    const db = getTestDb();
    const [{ id: listed }] = await db<{ id: number }[]>`
      INSERT INTO fleet_proxies (label, url_enc, host, port, timezone) VALUES ('NJ1', ${seal(url(10018), key())}, 'isp.example.net', 10018, 'America/New_York')
      RETURNING id`;
    const a = await seededSlot(1, 10001);
    const b = await seededSlot(2, 10001);
    const c = await seededSlot(3, 10018);
    const at = new Date('2026-10-28T04:54:04Z');
    await db`UPDATE fleet_proxy_rounds SET coordinator = 'ok', coordinator_at = ${at}`;
    await db`INSERT INTO fleet_proxy_checks (exit, source, checked_at, ok, city) VALUES
      ('http://isp.example.net:10001', 'coordinator', ${at}, TRUE, 'Ashburn'),
      ('http://isp.example.net:10014', 'coordinator', ${at}, TRUE, NULL),
      ('http://other.example.net:20000', 'coordinator', ${at}, TRUE, NULL)`;

    const dry = link(['--dry-run']);
    expect(dry).toContain('would link 3 slots');
    expect((await proxyIds()).every((s) => s.proxy_id === null)).toBe(true);

    expect(link()).toContain('linked 3 slots · proxies created 2, already listed 1');
    const proxies = await listProxies(db);
    const byPort = new Map(proxies.map((p) => [p.port, p]));
    expect(byPort.get(10018)!.id).toBe(listed);
    expect(byPort.get(10018)!.slots.map((s) => s.account_no)).toEqual([c]);
    expect(byPort.get(10001)).toMatchObject({ label: 'Decodo :10001 (Ashburn)', timezone: 'America/Chicago' });
    expect(byPort.get(10001)!.slots.map((s) => s.account_no)).toEqual([a, b]);
    // An unused homelab port, on a host whose login a slot gave; the other host's is unknown.
    expect(byPort.get(10014)).toMatchObject({ label: 'Decodo :10014', timezone: 'America/New_York', slots: [] });
    expect(byPort.has(20000)).toBe(false);
    const [made] = await db<{ url_enc: string }[]>`SELECT url_enc FROM fleet_proxies WHERE port = 10014`;
    expect(unseal(made.url_enc, key())).toBe(url(10014));

    const again = link();
    expect(again).toContain('linked 0 slots · proxies created 0, already listed 0');
    expect(await db`SELECT id FROM fleet_proxies`).toHaveLength(3);
  });

  it('refuses a remote database without FLEET_LINK_REMOTE', () => {
    const r = spawnSync('node', [join(backendRoot, 'scripts', 'fleet-link-proxies.mjs')], {
      env: { ...process.env, DATABASE_URL: 'postgres://u:p@db.example.com:5432/erp', JWT_SECRET: testEnv.JWT_SECRET, NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FLEET_LINK_REMOTE=true');
  });
});
