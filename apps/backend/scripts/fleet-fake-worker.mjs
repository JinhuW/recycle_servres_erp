#!/usr/bin/env node
// A stand-in for a fleet worker container, for checking the claim protocol
// end to end against a running backend without a browser or a Facebook login.
// It claims a slot with a host token, heartbeats HEALTHY, long-polls for tasks,
// "searches" each one for a few seconds with the events a real worker sends,
// reports it done, and stops after the number of tasks asked for.
//
//   node scripts/fleet-fake-worker.mjs --url http://127.0.0.1:8787 --host lab --token <host token> \
//        --worker lab-1 [--tasks 2] [--wait 50] [--work 3] [--version 0.14.0]
//
// Exit codes follow the worker contract: 0 when done, 75 on no_slot or a stale
// epoch, 70 when the claim fails otherwise. It prints one JSON line per step
// and never prints a password, cookie, token or proxy login.

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}

const url = (arg('--url') ?? '').replace(/\/$/, '');
const hostId = arg('--host');
const hostToken = arg('--token');
const workerId = arg('--worker');
const tasksWanted = Number(arg('--tasks', '2'));
const wait = Number(arg('--wait', '50'));
const workSeconds = Number(arg('--work', '3'));
const version = arg('--version', '0.14.0');
if (!url || !hostId || !hostToken || !workerId) {
  console.error('usage: fleet-fake-worker.mjs --url <erp> --host <host_id> --token <host token> --worker <worker_id> [--tasks n] [--wait s] [--work s]');
  process.exit(2);
}

const say = (step, detail = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), worker: workerId, step, ...detail }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token, timeoutMs = 15_000) {
  const res = await fetch(url + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

// ── Claim ──
let claim;
for (let attempt = 1; ; attempt++) {
  let r;
  try {
    r = await call('POST', '/api/fleet/worker/claim', { host_id: hostId, worker_id: workerId, version, vnc_port: 5901 }, hostToken);
  } catch (e) {
    r = { status: 0, body: { error: e.message } };
  }
  if (r.status === 200) { claim = r.body; break; }
  if (r.status === 409 && r.body?.error === 'no_slot') { say('no_slot', { exit: 75 }); process.exit(75); }
  say('claim_failed', { attempt, status: r.status, error: r.body?.error, detail: r.body?.detail });
  if (attempt >= 3) process.exit(70);
  await sleep(2000);
}
const token = claim.worker_token;
say('claimed', {
  account_no: claim.account.no, epoch: claim.epoch, home_cities: claim.home_cities, items: claim.items.map((i) => i.name),
  cookies: claim.account.cookies.length, has_proxy: claim.proxy !== null, has_token: claim.account.token !== null,
  device: claim.device.timezone, settings: claim.settings,
});

let stale = false;
const staleExit = (where, r) => {
  if (r.status === 409 && r.body?.error === 'stale_epoch') {
    say('stale_epoch', { where, exit: 75 });
    stale = true;
    process.exit(75);
  }
};

// ── Heartbeats, every 10 s while the loop runs ──
let lastSearchAt = null;
const beat = async () => {
  try {
    const r = await call('POST', '/api/fleet/worker/heartbeat', { state: 'HEALTHY', version, vnc_port: 5901, last_search_at: lastSearchAt, detail: { fake: true } }, token);
    staleExit('heartbeat', r);
    if (r.status !== 200) say('heartbeat_failed', { status: r.status, body: r.body });
  } catch (e) {
    say('heartbeat_error', { error: e.message });
  }
};
await beat();
const timer = setInterval(beat, 10_000);

// ── Poll, search, report ──
let done = null;
let received = 0;
while (received < tasksWanted && !stale) {
  const asked = Date.now();
  let r;
  try {
    r = await call('POST', '/api/fleet/worker/next-task', { done, wait }, token, (wait + 10) * 1000);
  } catch (e) {
    say('poll_error', { error: e.message });
    await sleep(5000);
    continue;
  }
  done = null;
  staleExit('next-task', r);
  if (r.status !== 200) { say('poll_failed', { status: r.status, body: r.body }); await sleep(5000); continue; }
  if (!r.body.task) { say('nothing', { reason: r.body.reason, retry_after: r.body.retry_after, held_ms: Date.now() - asked }); continue; }
  const task = r.body.task;
  received++;
  say('task', { id: task.id, kind: task.kind, city: task.city.slug, item: task.item, why: task.why, lease_expires_at: task.lease_expires_at, held_ms: Date.now() - asked });
  const event = (kind, detail) => call('POST', '/api/fleet/worker/events', { task_id: task.id, kind, detail }, token).then((e) => staleExit('events', e));
  await event('started', {});
  const started = Date.now();
  if (task.kind === 'verify-slug') {
    await sleep(workSeconds * 1000);
    await event('finished', { location: task.city.name, matches: true, seconds: workSeconds });
    done = { task_id: task.id, result: { seconds: workSeconds } };
  } else {
    await sleep(workSeconds * 1000);
    await event('searched', { phrase: 'fake', cards: 12 });
    await event('finished', { seconds: Math.round((Date.now() - started) / 1000) });
    done = { task_id: task.id, result: { cards: 12, opened: 1, reviewed: 1, alerted: 0, seconds: Math.round((Date.now() - started) / 1000) } };
  }
  lastSearchAt = new Date().toISOString();
  say('finished', { id: task.id });
}
// Report the last one done without asking for more.
if (done) {
  const r = await call('POST', '/api/fleet/worker/next-task', { done, wait: 0 }, token);
  staleExit('next-task', r);
  say('reported', { id: done.task_id, next: r.body?.task ? r.body.task.id : null });
}
// Hand the session back the way a worker does on its 30-minute save.
const s = await call('PUT', '/api/fleet/worker/session', { cookies: claim.account.cookies, token: claim.account.token }, token);
staleExit('session', s);
say('session_saved', { status: s.status });
clearInterval(timer);
say('done', { tasks: received });
