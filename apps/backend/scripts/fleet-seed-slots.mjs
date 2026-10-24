#!/usr/bin/env node
// Seed fleet_slots from the account pool: one slot per fb_pool_accounts row
// with status `fleet`, joined to the worker it runs on today through its open
// fb_worker_accounts stint. Home cities and device profiles come from two JSON
// files exported from the coordinator (the plan's WS-F has the export
// procedure); the proxy login comes from the environment and is sealed with
// FB_POOL_KEY before it is written. Nothing secret is printed.
//
//   node scripts/fleet-seed-slots.mjs --home-cities home-cities.json --devices devices.json [--dry-run]
//
//   home-cities.json  { "<worker_id>": ["<slug>", …], … }
//   devices.json      { "<fb_uid>": { user_agent, viewport: [w, h], screen, device_scale_factor, locale, timezone }, … }
//   FLEET_SEED_PROXY_USER / FLEET_SEED_PROXY_PASS   the login for every proxy exit (optional)
//
// Re-running is safe: an existing slot keeps its epoch, lease and worker, and
// only takes a proxy, device or home-city list the files or the stint provide.
// --dry-run prints what would change and rolls the transaction back.

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import './load-env.mjs';
import { poolKey, seal } from '../src/lib/sealed.ts';
import { dbTarget } from '../src/lib/dbTarget.ts';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
const dryRun = process.argv.includes('--dry-run');
class DryRun extends Error {}
const homeCitiesPath = arg('--home-cities');
const devicesPath = arg('--devices');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to the repo-root .env');
  process.exit(1);
}
const key = poolKey(process.env);
if (!key) {
  console.error('FB_POOL_KEY is not set (production derives nothing); the proxy login cannot be sealed');
  process.exit(1);
}

function readJson(path, what) {
  if (!path) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`${what}: cannot read ${path}: ${e.message}`);
    process.exit(1);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`${what}: ${path} must be a JSON object`);
    process.exit(1);
  }
  return parsed;
}

const homeCities = readJson(homeCitiesPath, 'home cities');
const devices = readJson(devicesPath, 'devices');
const proxyUser = process.env.FLEET_SEED_PROXY_USER ?? '';
const proxyPass = process.env.FLEET_SEED_PROXY_PASS ?? '';
if ((proxyUser === '') !== (proxyPass === '')) {
  console.error('set both FLEET_SEED_PROXY_USER and FLEET_SEED_PROXY_PASS, or neither');
  process.exit(1);
}

// Worker ids in the export are the coordinator's; the stint holds what the ERP
// wrote at Assign time. They are the same id, but not always the same case.
const homeByWorker = new Map(Object.entries(homeCities).map(([w, cities]) => [w.toLowerCase(), cities]));

/** The exit the stint names, with the login added: scheme://user:pass@host:port. */
function withLogin(exit) {
  let u;
  try {
    u = new URL(exit);
  } catch {
    return null;
  }
  if (proxyUser) {
    u.username = encodeURIComponent(proxyUser);
    u.password = encodeURIComponent(proxyPass);
  }
  return u.toString().replace(/\/$/, '');
}

function deviceOf(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const viewport = Array.isArray(raw.viewport) && raw.viewport.length === 2 ? raw.viewport.map(Number) : null;
  if (!viewport || !raw.user_agent) return null;
  return {
    user_agent: String(raw.user_agent),
    viewport,
    ...(Array.isArray(raw.screen) ? { screen: raw.screen.map(Number) } : {}),
    ...(raw.device_scale_factor !== undefined ? { device_scale_factor: Number(raw.device_scale_factor) } : {}),
    locale: raw.locale ? String(raw.locale) : 'en-US',
    timezone: raw.timezone ? String(raw.timezone) : 'America/New_York',
  };
}

console.log(`${dryRun ? 'dry run against' : 'seeding slots on'} ${dbTarget(url).host}`);
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const rows = await sql`
    SELECT a.no, a.uid, a.holder_name, w.worker_id, w.proxy_url, w.proxy_known,
           (s.account_no IS NOT NULL) AS has_slot, s.proxy_url IS NOT NULL AS has_proxy,
           s.home_cities AS slot_home, s.device IS NOT NULL AS has_device
    FROM fb_pool_accounts a
    LEFT JOIN fb_worker_accounts w ON w.account_no = a.no AND w.ended_at IS NULL
    LEFT JOIN fleet_slots s ON s.account_no = a.no
    WHERE a.status = 'fleet'
    ORDER BY a.no`;
  if (rows.length === 0) console.log('no fleet accounts in the pool; nothing to seed');

  const summary = { created: 0, updated: 0, unchanged: 0, noStint: 0, noHome: 0, noDevice: 0, noProxy: 0 };
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const worker = r.worker_id ?? r.holder_name;
      if (!r.worker_id) summary.noStint++;
      const home = worker ? homeByWorker.get(worker.toLowerCase()) : undefined;
      const homeList = Array.isArray(home) ? home.map(String) : null;
      if (!homeList) summary.noHome++;
      const device = deviceOf(devices[r.uid]);
      if (!device) summary.noDevice++;
      const proxy = r.proxy_url ? withLogin(r.proxy_url) : null;
      if (!proxy) summary.noProxy++;
      const sealedProxy = proxy ? seal(proxy, key) : null;

      const [out] = await tx`
        INSERT INTO fleet_slots (account_no, proxy_url, device, home_cities)
        VALUES (${r.no}, ${sealedProxy}, ${device ? tx.json(device) : null}, ${tx.json(homeList ?? [])})
        ON CONFLICT (account_no) DO UPDATE SET
          proxy_url   = COALESCE(EXCLUDED.proxy_url, fleet_slots.proxy_url),
          device      = COALESCE(EXCLUDED.device, fleet_slots.device),
          home_cities = CASE WHEN EXCLUDED.home_cities <> '[]'::jsonb THEN EXCLUDED.home_cities ELSE fleet_slots.home_cities END
        RETURNING (xmax = 0) AS inserted, proxy_url IS NOT NULL AS has_proxy, device IS NOT NULL AS has_device, home_cities`;
      const changed = !r.has_slot || out.has_proxy !== r.has_proxy || out.has_device !== r.has_device
        || JSON.stringify(out.home_cities) !== JSON.stringify(r.slot_home);
      if (out.inserted) summary.created++;
      else if (changed) summary.updated++;
      else summary.unchanged++;
      const exit = r.proxy_url ? r.proxy_url.replace(/^[a-z]+:\/\/(?:[^@]*@)?/i, '') : null;
      console.log(
        `#${String(r.no).padStart(3)} ${(worker ?? '(no worker)').padEnd(16)} ${out.inserted ? 'new     ' : changed ? 'updated ' : 'same    '}`
        + ` home=${out.home_cities.length}${homeList ? '' : ' (not in file)'}`
        + ` device=${out.has_device ? 'yes' : 'no'}${device ? '' : ' (not in file)'}`
        + ` proxy=${out.has_proxy ? (exit ?? 'kept') : 'none'}${proxy && !proxyUser ? ' (no login)' : ''}`
        + `${r.worker_id ? '' : ' (no open stint)'}`,
      );
    }
    if (dryRun) {
      // The transaction is abandoned, so nothing above sticks.
      throw new DryRun();
    }
  }).catch((e) => {
    if (!(e instanceof DryRun)) throw e;
  });
  console.log(
    `${dryRun ? 'would create' : 'created'} ${summary.created}, ${dryRun ? 'update' : 'updated'} ${summary.updated}, unchanged ${summary.unchanged}`
    + ` · without open stint ${summary.noStint}, without home cities ${summary.noHome}, without device ${summary.noDevice}, without proxy ${summary.noProxy}`
    + (dryRun ? ' (rolled back)' : ''),
  );
} finally {
  await sql.end();
}
