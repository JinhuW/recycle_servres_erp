#!/usr/bin/env node
// Link every fleet slot that names no proxy to the proxy list. The slots
// fleet-seed-slots.mjs writes carry a sealed proxy_url but no proxy_id, and
// the list counts a proxy's accounts, and Add to fleet its limit, by
// proxy_id alone: unlinked, a port in use reads as free on the list and is
// missing from the picker. Each slot's URL is unsealed to its host:port; the
// proxy of that exit is found or made from the slot's sealed URL and its
// device's timezone. The ports of the last coordinator round on a host whose
// login a slot gave are listed too, so an unused homelab port becomes one Add
// to fleet can offer. A claim reads only proxy_url, which nothing here
// touches, so no worker notices. Nothing secret is printed.
//
//   node scripts/fleet-link-proxies.mjs [--dry-run]
//
// Re-running is safe: a linked slot is skipped and a listed exit reused.
// --dry-run prints what would change and rolls the transaction back.
// A DATABASE_URL that is not local needs FLEET_LINK_REMOTE=true.

import postgres from 'postgres';
import './load-env.mjs';
import { poolKey, seal, unseal } from '../src/lib/sealed.ts';
import { dbTarget, destructiveRefusal } from '../src/lib/dbTarget.ts';

const dryRun = process.argv.includes('--dry-run');
class DryRun extends Error {}
const DEFAULT_TIMEZONE = 'America/New_York';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to the repo-root .env');
  process.exit(1);
}
if (!dryRun) {
  const refused = destructiveRefusal(url, 'fleet proxy linking', 'FLEET_LINK_REMOTE', process.env);
  if (refused) {
    console.error(refused);
    process.exit(1);
  }
}
const key = poolKey(process.env);
if (!key) {
  console.error('FB_POOL_KEY is not set (production derives nothing); the slots\' proxies cannot be unsealed');
  process.exit(1);
}

const exitOf = (u) => `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;

console.log(`${dryRun ? 'dry run against' : 'linking proxies on'} ${dbTarget(url).host}/${dbTarget(url).database}`);
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const summary = { linked: 0, created: 0, reused: 0, unreadable: 0 };
  await sql.begin(async (tx) => {
    // The pool-then-slot lock order every slot write takes.
    await tx`SELECT a.no FROM fb_pool_accounts a JOIN fleet_slots s ON s.account_no = a.no
             WHERE s.proxy_id IS NULL ORDER BY a.no FOR NO KEY UPDATE OF a`;
    const slots = await tx`
      SELECT account_no, proxy_url, device->>'timezone' AS timezone FROM fleet_slots
      WHERE proxy_id IS NULL AND proxy_url IS NOT NULL ORDER BY account_no FOR UPDATE`;
    const listed = await tx`SELECT id, lower(host) AS host, port FROM fleet_proxies`;
    const proxyOf = new Map(listed.map((p) => [`${p.host}:${p.port}`, p.id]));
    // A city names a made proxy; the newest answer of each exit has it.
    const cities = await tx`
      SELECT DISTINCT ON (exit) exit, city FROM fleet_proxy_checks
      WHERE ok AND city IS NOT NULL ORDER BY exit, checked_at DESC`;
    const cityOf = new Map();
    for (const c of cities) {
      try { cityOf.set(exitOf(new URL(c.exit)), c.city); } catch { /* an exit the list never parsed */ }
    }

    const byExit = new Map();
    const loginOf = new Map();
    for (const s of slots) {
      let u;
      try {
        u = new URL(unseal(s.proxy_url, key));
      } catch {
        summary.unreadable++;
        console.log(`#${String(s.account_no).padStart(3)} proxy cannot be unsealed or parsed; left unlinked`);
        continue;
      }
      const exit = exitOf(u);
      if (!byExit.has(exit)) byExit.set(exit, { host: u.hostname.toLowerCase(), port: Number(exit.split(':')[1]), sealed: s.proxy_url, timezone: s.timezone, nos: [] });
      byExit.get(exit).nos.push(s.account_no);
      if (u.username && !loginOf.has(u.hostname.toLowerCase())) loginOf.set(u.hostname.toLowerCase(), u);
    }

    async function make(exit, host, port, sealed, timezone) {
      const city = cityOf.get(exit);
      const [{ id }] = await tx`
        INSERT INTO fleet_proxies (label, url_enc, host, port, timezone, note)
        VALUES (${`Decodo :${port}${city ? ` (${city})` : ''}`}, ${sealed}, ${host}, ${port}, ${timezone ?? DEFAULT_TIMEZONE},
                'Linked from the fleet slots by fleet-link-proxies.mjs')
        RETURNING id`;
      proxyOf.set(exit, id);
      summary.created++;
      return id;
    }

    for (const [exit, e] of [...byExit].sort(([a], [b]) => a.localeCompare(b))) {
      const had = proxyOf.get(exit);
      const id = had ?? await make(exit, e.host, e.port, e.sealed, e.timezone);
      if (had) summary.reused++;
      await tx`UPDATE fleet_slots SET proxy_id = ${id} WHERE account_no = ANY(${e.nos}::int[])`;
      summary.linked += e.nos.length;
      console.log(`${exit.padEnd(24)} proxy ${String(id).padStart(3)} ${had ? 'listed ' : 'created'} slots ${e.nos.map((n) => `#${n}`).join(' ')}`);
    }

    const ports = await tx`
      SELECT DISTINCT c.exit FROM fleet_proxy_checks c JOIN fleet_proxy_rounds r ON c.checked_at = r.coordinator_at
      WHERE c.source = 'coordinator' ORDER BY c.exit`;
    for (const { exit: raw } of ports) {
      let u;
      try { u = new URL(raw); } catch { continue; }
      const exit = exitOf(u);
      const login = loginOf.get(u.hostname.toLowerCase());
      if (proxyOf.has(exit) || !login) continue;
      const withLogin = new URL(login.href);
      withLogin.port = u.port;
      const port = Number(exit.split(':')[1]);
      const id = await make(exit, u.hostname.toLowerCase(), port, seal(withLogin.href.replace(/\/$/, ''), key), null);
      console.log(`${exit.padEnd(24)} proxy ${String(id).padStart(3)} created no slots (a homelab port, ${DEFAULT_TIMEZONE})`);
    }

    if (dryRun) throw new DryRun();
  }).catch((e) => {
    if (!(e instanceof DryRun)) throw e;
  });
  console.log(
    `${dryRun ? 'would link' : 'linked'} ${summary.linked} slots · proxies ${dryRun ? 'to create' : 'created'} ${summary.created}, already listed ${summary.reused}`
    + (summary.unreadable ? ` · unreadable ${summary.unreadable}` : '')
    + (dryRun ? ' (rolled back)' : ''),
  );
} finally {
  await sql.end();
}
