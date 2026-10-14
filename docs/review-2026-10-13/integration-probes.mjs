// Run from repository root:
// pnpm --filter recycle-erp-backend exec node --import tsx ../../docs/review-2026-10-13/integration-probes.mjs
// These probes assert the reviewed defects still exist. No database or external service is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { shrinkImageToFit } from '../../apps/backend/src/lib/image-shrink.ts';
import { registerPackageTracking } from '../../apps/backend/src/shipping/track.ts';
import { openRouterScan } from '../../apps/backend/src/ai/openrouter.ts';
import { parseModelJson } from '../../apps/backend/src/ai/prompts.ts';
const requireBackend = createRequire(new URL('../../apps/backend/package.json', import.meta.url));
const sharp = requireBackend('sharp');

const avif = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).avif().toBuffer();
const forged = new File([avif], 'forged.png', { type: 'image/png' });
assert.equal((await sharp(avif).metadata()).format, 'heif');
assert.equal(await shrinkImageToFit(forged, 100_000, { strict: true }), forged);
console.log('DEP-01: disguised HEIF accepted by public strict image gate', sharp.versions.sharp, sharp.versions.heif);

let calls = 0;
let stamps = 0;
const sql = async () => { stamps++; return []; };
const provider = { registerTracking: async () => { calls++; await Promise.resolve(); } };
const row = { id: 'probe', tracking_number: '1234567890', carrier: 'USPS' };
await Promise.all([registerPackageTracking(sql, provider, row), registerPackageTracking(sql, provider, row)]);
assert.equal(calls, 2);
assert.equal(stamps, 2);
console.log('INF-03: concurrent registration callers both reach the provider');

const syncSource = readFileSync(new URL('../../deploy/railway-sync/sync.sh', import.meta.url), 'utf8');
assert.ok(syncSource.includes('[ "$prod_host" = "$dev_host" ]'));
assert.ok(syncSource.includes('[ -n "${EXPECTED_DEV_DB_HOST:-}" ]'));
const source = 'postgres://reader:fake@public-proxy.test:1234/recycle';
const target = 'postgres://writer:fake@postgres.railway.internal:5432/recycle';
const scriptHost = s => s.replace(/^[^@]*@/, '').replace(/\/.*$/, '');
assert.notEqual(source, target);
assert.notEqual(scriptHost(source), scriptHost(target));
console.log('INF-04: alias URLs pass the two unconditional source/target identity comparisons');

const oldFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ _confidence: 0, ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['unknown' + i, 'value'])) }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  const scan = await openRouterScan({ OPENROUTER_API_KEY: 'probe-not-a-key' }, 'RAM', new ArrayBuffer(0));
  assert.equal(scan.confidence, 0.8);
  assert.deepEqual(Object.keys(scan.fields).filter(k => ['brand', 'capacity', 'generation', 'type', 'classification', 'rank', 'speed', 'partNumber'].includes(k)), []);
  assert.equal(parseModelJson('42'), 42);
  assert.deepEqual(parseModelJson('[]'), []);
  console.log('INT-03: unknown fields raise confidence to 0.8; parser accepts non-object JSON');
} finally { globalThis.fetch = oldFetch; }
