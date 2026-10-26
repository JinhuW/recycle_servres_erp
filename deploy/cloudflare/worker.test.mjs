// The Worker's proxy path, driven with a fake env and a fake fetch.
// Run: apps/backend/node_modules/.bin/tsx --test deploy/cloudflare/worker.test.mjs
// (tsx because worker.js imports the frontend's TypeScript shellPaths.)
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import imported from './worker.js';

// No package.json here says "module", so tsx loads worker.js as CommonJS and
// its default export arrives one level down.
const worker = imported.fetch ? imported : imported.default;

const SHARED = { OPENROUTER_API_KEY: 'sk-made-up', TELEGRAM_CHAT_ID: '-100123' };
const CLAIM = { worker_token: 't', epoch: 3, settings: { coordinator_url: null } };

let seen;
let answer;
let logs;
const realFetch = globalThis.fetch;
const realLog = console.log;

beforeEach(() => {
  seen = [];
  logs = [];
  answer = () => new Response(JSON.stringify(CLAIM), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': '999' } });
  globalThis.fetch = async (req) => {
    seen.push(req);
    return answer(req);
  };
  console.log = (...a) => logs.push(a.join(' '));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

function env(over = {}) {
  return { BACKEND_URL: 'https://backend.example', FLEET_WORKER_ENV: JSON.stringify(SHARED), ...over };
}

function claim(method = 'POST', path = '/api/fleet/worker/claim') {
  return new Request(`https://inventory-dev.example${path}`, {
    method,
    headers: { Authorization: 'Bearer host', 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ host_id: 'h', worker_id: 'h-1' }) : undefined,
  });
}

test('a 200 claim carries the shared env, with the length recomputed', async () => {
  const res = await worker.fetch(claim(), env());
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ...CLAIM, env: SHARED });
  assert.notEqual(res.headers.get('Content-Length'), '999');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(seen[0].url, 'https://backend.example/api/fleet/worker/claim');
  assert.equal(seen[0].headers.get('Authorization'), 'Bearer host');
});

test('a refused claim passes through untouched and carries no env', async () => {
  for (const status of [401, 409, 422]) {
    answer = () => new Response(JSON.stringify({ error: 'x' }), { status });
    const res = await worker.fetch(claim(), env());
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error: 'x' });
  }
});

test('no secret, or one that is not an object of strings: no env key, one line without the value', async () => {
  const bad = [undefined, '', 'not json', '[]', '"s"', JSON.stringify({ A: 1 }), JSON.stringify({ A: 'ok', B: null })];
  for (const value of bad) {
    logs = [];
    const res = await worker.fetch(claim(), env({ FLEET_WORKER_ENV: value }));
    assert.deepEqual(await res.json(), CLAIM);
    assert.equal(logs.length, 1);
    if (value) assert.ok(!logs[0].includes(value), 'the log line must not carry the secret');
  }
});

test('other routes and methods are not rewritten', async () => {
  answer = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  for (const req of [claim('POST', '/api/fleet/worker/heartbeat'), claim('GET'), claim('POST', '/api/fleet/worker/claim/x')]) {
    const res = await worker.fetch(req, env());
    assert.deepEqual(await res.json(), { ok: true });
  }
});

test('a response the Worker did not rewrite is the origin response itself (streams, upgrades)', async () => {
  const origin = new Response('held', { status: 200 });
  answer = () => origin;
  const req = new Request('https://inventory-dev.example/api/fleet/worker/vnc', {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade', Authorization: 'Bearer w' },
  });
  const res = await worker.fetch(req, env());
  assert.equal(res, origin);
  assert.equal(seen[0].headers.get('Upgrade'), 'websocket');
  assert.equal(seen[0].headers.get('Authorization'), 'Bearer w');
});
