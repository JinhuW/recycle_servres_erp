// A stand-in for a seller worker, for walking the Facebook seller flow end to
// end on a local ERP with no browser and no Facebook. It speaks the real worker
// protocol: claims a seller slot with a host token, heartbeats HEALTHY,
// long-polls next-task, answers each seller task from a script, and reports
// through /api/fleet/worker/seller/report before `done`, as the monitor does.
//
//   ad-post     ok, a made-up listing id
//   ad-delete   ok
//   inbox-sync  the scripted conversations, one more seller message each sync
//               once our replies have caught up, plus every reply we "sent"
//   msg-send    lands: it is appended to the thread as ours
//
//   npx tsx scripts/fake-seller-worker.ts --url http://127.0.0.1:8787 --host lab --token <host token> \
//       --worker lab-seller-1 --script conversations.json [--wait 25] [--version <v>]
//   npx tsx scripts/fake-seller-worker.ts --seed --host lab --token <host token> [--accounts 2]
//
// --seed writes a host and made-up seller slots (role 'seller', agent_on) into
// the local DATABASE_URL and refuses any other database. The reported version
// defaults to FLEET_SELLER_MIN_WORKER_VERSION, so the shared constant is
// satisfied without changing it; --version or FAKE_SELLER_WORKER_VERSION
// overrides it.
//
// The script file:
//   { "threads": [ { "fb_thread_id": "t-1", "seller_name": "…", "listing_title": "…",
//                    "messages": [ { "after_out": 0, "body": "…", "has_image": false }, … ] } ] }
// The inbox stays empty until an ad-post lands, as a real one would. Then a
// seller message shows once the thread holds at least `after_out` of our
// messages, one new seller message per thread per sync. A message with
// `"gate": "<name>"` also waits for a file `<script>.gate-<name>` to exist, so a
// walk can hold one seller back until it has set something up.
//
// Only a local ERP: against a real one it would claim a real account. It never
// prints a password, cookie or token.

import { existsSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { FLEET_SELLER_MIN_WORKER_VERSION, type ClaimAnswer, type HandedTask, type InboxThread, type NextTaskAnswer, type SellerReport } from '@recycle-erp/shared';
import { poolKey, seal } from '../src/lib/sealed';
import { destructiveRefusal } from '../src/lib/dbTarget';
import { sha256hex } from '../src/fleet/sql';

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}
const say = (step: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), step, ...detail }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hostId = arg('--host');
const hostToken = arg('--token');
if (!hostId || !hostToken) {
  console.error('usage: fake-seller-worker.ts (--seed | --url <erp> --worker <id> --script <file>) --host <host_id> --token <host token>');
  process.exit(2);
}

// ── Seed ──────────────────────────────────────────────────────────────────
if (process.argv.includes('--seed')) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const refused = destructiveRefusal(url, 'fake seller seeding', 'FAKE_SELLER_SEED_REMOTE', process.env);
  if (refused || process.env.FAKE_SELLER_SEED_REMOTE) { console.error(refused ?? 'fake seller slots never go into a remote database'); process.exit(1); }
  const key = poolKey(process.env as never);
  if (!key) { console.error('no pool key'); process.exit(1); }
  const count = Number(arg('--accounts', '1'));
  const sql = postgres(url, { max: 1 });
  const nos: number[] = [];
  await sql.begin(async (tx) => {
    await tx`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative)
             VALUES (${hostId}, ${sha256hex(hostToken)}, ${count}, TRUE)
             ON CONFLICT (host_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, capacity = EXCLUDED.capacity`;
    for (let n = 1; n <= count; n++) {
      const uid = `61550000000${String(n).padStart(4, '0')}`;
      const [a] = await tx<{ no: number }[]>`
        INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, cookie_enc, cookie_uid)
        VALUES (${uid}, 'fake-seller', 'fleet', ${`Fake Seller ${n}`}, ${seal(`made-up-${n}`, key)},
                ${seal(`c_user=${uid}; xs=made-up-${n}`, key)}, ${uid})
        ON CONFLICT (uid) DO UPDATE SET batch = EXCLUDED.batch
        RETURNING no`;
      await tx`INSERT INTO fleet_slots (account_no, role, agent_on, last_host_id) VALUES (${a.no}, 'seller', TRUE, ${hostId})
               ON CONFLICT (account_no) DO UPDATE SET role = 'seller', agent_on = TRUE, last_host_id = EXCLUDED.last_host_id`;
      nos.push(a.no);
    }
  });
  await sql.end();
  say('seeded', { host: hostId, accounts: nos });
  process.exit(0);
}

// ── Worker ────────────────────────────────────────────────────────────────
const url = (arg('--url') ?? '').replace(/\/$/, '');
const workerId = arg('--worker');
const scriptPath = arg('--script');
const wait = Number(arg('--wait', '25'));
const version = arg('--version') ?? process.env.FAKE_SELLER_WORKER_VERSION ?? FLEET_SELLER_MIN_WORKER_VERSION;
if (!url || !workerId || !scriptPath) {
  console.error('the worker needs --url, --worker and --script');
  process.exit(2);
}
let target = '';
try { target = new URL(url).hostname; } catch { /* refused below */ }
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(target)) {
  console.error(`refusing ${target || url}: not a local ERP. A fake worker there would claim a real account.`);
  process.exit(2);
}

type ScriptThread = Omit<InboxThread, 'messages'> & { messages: { after_out: number; body: string; has_image?: boolean; gate?: string }[] };
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as { threads: ScriptThread[] };
/** What each thread's page would show: seller messages released so far and our sent replies, in order. */
let posted = false;
const pages = new Map(script.threads.map((t) => [t.fb_thread_id, { shown: 0, window: [] as InboxThread['messages'] }]));

async function call<T>(method: string, path: string, body: unknown, token: string, timeoutMs = 15_000): Promise<{ status: number; body: T }> {
  const res = await fetch(url + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json as T };
}

const claim = await call<ClaimAnswer & { error?: string; detail?: string }>('POST', '/api/fleet/worker/claim',
  { host_id: hostId, worker_id: workerId, version, vnc_port: 5901 }, hostToken);
if (claim.status !== 200) {
  say('claim_failed', { status: claim.status, error: claim.body.error, detail: claim.body.detail });
  process.exit(claim.status === 409 ? 75 : 70);
}
const token = claim.body.worker_token;
say('claimed', { account_no: claim.body.account.no, epoch: claim.body.epoch, version });

const exitIfStale = (where: string, r: { status: number; body: unknown }) => {
  if (r.status === 401 || (r.status === 409 && (r.body as { error?: string })?.error === 'stale_epoch')) {
    say('stale', { where, status: r.status });
    process.exit(75);
  }
};

const beat = async () => {
  try {
    const r = await call('POST', '/api/fleet/worker/heartbeat', { state: 'HEALTHY', version, vnc_port: 5901, last_search_at: null, detail: { fake_seller: true } }, token);
    exitIfStale('heartbeat', r);
  } catch (e) {
    say('heartbeat_error', { error: (e as Error).message });
  }
};
await beat();
setInterval(beat, 10_000);

function answer(task: Extract<HandedTask, { city: null }>): Omit<SellerReport, 'task_id' | 'kind' | 'ref'> {
  const p = task.payload;
  switch (p.kind) {
    case 'ad-post':
      posted = true;
      return { outcome: 'ok', data: { fb_listing_id: String(9_100_000_000_000 + task.id) } };
    case 'ad-delete':
      return { outcome: 'ok', data: {} };
    case 'msg-send': {
      const page = pages.get(p.fb_thread_id);
      if (!page) return { outcome: 'failed', detail: `No conversation ${p.fb_thread_id} in the fake inbox.` };
      page.window.push({ direction: 'out', body: p.body, has_image: false });
      return { outcome: 'ok', data: { already_sent: false } };
    }
    case 'inbox-sync': {
      const threads: InboxThread[] = [];
      for (const t of posted ? script.threads.slice(0, p.max_threads) : []) {
        const page = pages.get(t.fb_thread_id)!;
        const next = t.messages[page.shown];
        const ours = page.window.filter((m) => m.direction === 'out').length;
        if (next && ours >= next.after_out && (!next.gate || existsSync(`${scriptPath}.gate-${next.gate}`))) {
          page.window.push({ direction: 'in', body: next.body, has_image: next.has_image ?? false });
          page.shown++;
        }
        if (page.window.length === 0) continue;
        threads.push({ fb_thread_id: t.fb_thread_id, seller_name: t.seller_name, listing_title: t.listing_title, messages: page.window.slice(-p.max_messages) });
      }
      return { outcome: 'ok', data: { threads } };
    }
  }
}

let done: { task_id: number; result: Record<string, unknown> } | null = null;
for (;;) {
  let r: { status: number; body: NextTaskAnswer & { error?: string } };
  try {
    r = await call('POST', '/api/fleet/worker/next-task', { done, wait }, token, (wait + 10) * 1000);
  } catch (e) {
    say('poll_error', { error: (e as Error).message });
    await sleep(5000);
    continue;
  }
  exitIfStale('next-task', r);
  if (r.status !== 200) { say('poll_failed', { status: r.status, error: r.body?.error }); await sleep(5000); continue; }
  done = null;
  const task = r.body.task;
  if (!task) continue;
  if (task.city !== null) {
    say('search_task_refused', { id: task.id, kind: task.kind });
    done = { task_id: task.id, result: { stopped: true } };
    continue;
  }
  const started = Date.now();
  const a = answer(task);
  const report: SellerReport = { task_id: task.id, kind: task.payload.kind, ref: task.payload.ref, ...a };
  const rep = await call<{ accepted?: boolean; detail?: string }>('POST', '/api/fleet/worker/seller/report', report, token);
  exitIfStale('report', rep);
  const threads = report.kind === 'inbox-sync' ? (report.data as { threads: InboxThread[] }).threads : null;
  say('task', {
    id: task.id, kind: report.kind, ref: report.ref, outcome: report.outcome, accepted: rep.body?.accepted ?? null, detail: rep.body?.detail,
    ...(threads ? { threads: threads.length, messages: threads.reduce((s, t) => s + t.messages.length, 0) } : {}),
  });
  done = { task_id: task.id, result: { seconds: Math.round((Date.now() - started) / 1000), fake: true } };
}
