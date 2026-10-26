import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { AnswerCache, type Answer } from '../src/lib/coordinatorCache';
import { coordinatorCache } from '../src/routes/coordinator';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// A loader the test settles by hand, so "in flight" is a state it controls.
function deferredLoader() {
  const pending: Array<(a: Answer) => void> = [];
  const load = vi.fn(() => new Promise<Answer>((resolve) => { pending.push(resolve); }));
  return { load, settle: (a: Answer) => pending.shift()?.(a), pending };
}

const OK = (payload: unknown): Answer => ({ status: 200, payload });
const tick = () => new Promise((r) => setImmediate(r));

describe('AnswerCache', () => {
  let clock = 0;
  const make = () => new AnswerCache({ freshMs: 15_000, staleMs: 300_000, now: () => clock });
  beforeEach(() => { clock = 1_000_000; });

  it('shares one upstream call between concurrent readers on a miss', async () => {
    const cache = make();
    const { load, settle } = deferredLoader();
    const reads = Array.from({ length: 10 }, () => cache.get('k', load));
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    settle(OK({ n: 1 }));
    const got = await Promise.all(reads);
    expect(got.every((g) => g.cache === 'miss' && (g.payload as { n: number }).n === 1)).toBe(true);
  });

  it('serves a fresh copy without calling upstream, with its age', async () => {
    const cache = make();
    const load = vi.fn(async () => OK({ n: 1 }));
    await cache.get('k', load);
    clock += 14_000;
    const got = await cache.get('k', load);
    expect(got).toMatchObject({ cache: 'hit', ageS: 14, payload: { n: 1 } });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('answers a stale read at once and refreshes once in the background', async () => {
    const cache = make();
    await cache.get('k', async () => OK({ n: 1 }));
    clock += 20_000;
    const { load, settle } = deferredLoader();
    const first = await cache.get('k', load);
    const second = await cache.get('k', load);
    expect(first).toMatchObject({ cache: 'stale', ageS: 20, payload: { n: 1 } });
    expect(second.cache).toBe('stale');
    expect(load).toHaveBeenCalledTimes(1);
    settle(OK({ n: 2 }));
    await tick();
    expect(await cache.get('k', load)).toMatchObject({ cache: 'hit', ageS: 0, payload: { n: 2 } });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('makes the reader wait once the copy is past the stale window', async () => {
    const cache = make();
    await cache.get('k', async () => OK({ n: 1 }));
    clock += 300_000;
    const got = await cache.get('k', async () => OK({ n: 2 }));
    expect(got).toMatchObject({ cache: 'miss', payload: { n: 2 } });
  });

  it('caches only a 2xx, and serves the last good copy when upstream fails', async () => {
    const cache = make();
    const failing = vi.fn(async (): Promise<Answer> => ({ status: 502, payload: { error: 'down' } }));
    expect(await cache.get('k', failing)).toMatchObject({ status: 502, cache: 'miss' });
    expect(await cache.get('k', failing)).toMatchObject({ status: 502, cache: 'miss' });
    expect(failing).toHaveBeenCalledTimes(2);

    await cache.get('k', async () => OK({ n: 1 }));
    clock += 400_000;
    expect(await cache.get('k', failing)).toMatchObject({ status: 200, cache: 'stale', ageS: 400, payload: { n: 1 } });
    // A 4xx is the upstream's answer to this request, not an outage.
    expect(await cache.get('k', async () => ({ status: 404, payload: {} }))).toMatchObject({ status: 404 });
  });

  it('drops an answer that was in flight when the cache was cleared', async () => {
    const cache = make();
    const { load, settle } = deferredLoader();
    const read = cache.get('k', load);
    await tick();
    cache.clear();
    settle(OK({ before: true }));
    await read;
    const after = await cache.get('k', async () => OK({ before: false }));
    expect(after).toMatchObject({ cache: 'miss', payload: { before: false } });
  });
});

const ENV = {
  COORDINATOR_API_URL: 'http://facade.internal:8600',
  COORDINATOR_API_TOKEN: 'console-secret',
};
const UPSTREAM_MS = 300;

// A facade that takes UPSTREAM_MS per answer, as the real one takes seconds.
function slowFacade(body: (url: string) => unknown = () => ({ workers: [] }), status = () => 200) {
  const spy = vi.fn(async (url: string) => {
    await new Promise((r) => setTimeout(r, UPSTREAM_MS));
    return new Response(JSON.stringify(body(url)), { status: status() });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('Coordinator proxy read cache', () => {
  beforeEach(async () => {
    await resetDb();
    coordinatorCache.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers a burst of viewers with one console call, then from memory', async () => {
    const { token } = await loginAs(ALEX);
    const spy = slowFacade();

    const t0 = performance.now();
    const burst = await Promise.all(Array.from({ length: 8 }, () =>
      api('GET', '/api/coordinator/fleet', { token, env: ENV })));
    const coldMs = performance.now() - t0;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(burst.every((r) => r.status === 200 && r.headers.get('X-Cache') === 'miss')).toBe(true);

    const t1 = performance.now();
    const warm = await api('GET', '/api/coordinator/fleet', { token, env: ENV });
    const warmMs = performance.now() - t1;
    expect(warm.headers.get('X-Cache')).toBe('hit');
    expect(warm.headers.get('Age')).toBe('0');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(warmMs).toBeLessThan(UPSTREAM_MS);
    process.stdout.write(`coordinator fleet: cold ${coldMs.toFixed(0)} ms (8 concurrent), warm ${warmMs.toFixed(0)} ms\n`);
  });

  it('serves a stale copy at once and refreshes it once behind the reader', async () => {
    const { token } = await loginAs(ALEX);
    let n = 0;
    const spy = slowFacade(() => ({ n: ++n }));
    await api('GET', '/api/coordinator/fleet', { token, env: ENV });
    coordinatorCache._backdateForTests(20_000);

    const t0 = performance.now();
    const [a, b] = await Promise.all([
      api<{ n: number }>('GET', '/api/coordinator/fleet', { token, env: ENV }),
      api<{ n: number }>('GET', '/api/coordinator/fleet', { token, env: ENV }),
    ]);
    expect(performance.now() - t0).toBeLessThan(UPSTREAM_MS);
    expect([a.headers.get('X-Cache'), b.headers.get('X-Cache')]).toEqual(['stale', 'stale']);
    expect(a.headers.get('Age')).toBe('20');
    expect(a.body.n).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);

    await new Promise((r) => setTimeout(r, UPSTREAM_MS + 100));
    const fresh = await api<{ n: number }>('GET', '/api/coordinator/fleet', { token, env: ENV });
    expect(fresh.headers.get('X-Cache')).toBe('hit');
    expect(fresh.body.n).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('serves the last good copy when the console fails, and the error when it has none', async () => {
    const { token } = await loginAs(ALEX);
    let status = 200;
    slowFacade(() => (status === 200 ? { workers: ['ne-1'] } : { detail: 'console down' }), () => status);
    status = 503;
    expect((await api('GET', '/api/coordinator/fleet', { token, env: ENV })).status).toBe(503);
    status = 200;
    await api('GET', '/api/coordinator/fleet', { token, env: ENV });
    coordinatorCache._backdateForTests(400_000);
    status = 503;
    const r = await api<{ workers: string[] }>('GET', '/api/coordinator/fleet', { token, env: ENV });
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Cache')).toBe('stale');
    expect(r.body.workers).toEqual(['ne-1']);
  });

  it('forgets everything after a successful write, but not after a refused one', async () => {
    const { token } = await loginAs(ALEX);
    let status = 200;
    const spy = slowFacade(() => ({}), () => status);
    await api('GET', '/api/coordinator/fleet', { token, env: ENV });
    await api('GET', '/api/coordinator/challenges?status=open', { token, env: ENV });
    expect(spy).toHaveBeenCalledTimes(2);

    status = 409;
    await api('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV });
    status = 200;
    expect((await api('GET', '/api/coordinator/fleet', { token, env: ENV })).headers.get('X-Cache')).toBe('hit');

    await api('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV });
    const after = await api('GET', '/api/coordinator/fleet', { token, env: ENV });
    expect(after.headers.get('X-Cache')).toBe('miss');
    expect((await api('GET', '/api/coordinator/challenges?status=open', { token, env: ENV })).headers.get('X-Cache')).toBe('miss');
  });

  it('keys each query string separately', async () => {
    const { token } = await loginAs(ALEX);
    const spy = slowFacade((url) => ({ url }));
    const week = await api<{ url: string }>('GET', '/api/coordinator/stats/reviews?days=7', { token, env: ENV });
    const month = await api<{ url: string }>('GET', '/api/coordinator/stats/reviews?days=30', { token, env: ENV });
    expect(week.body.url).toMatch(/days=7$/);
    expect(month.body.url).toMatch(/days=30$/);
    expect(month.headers.get('X-Cache')).toBe('miss');
    expect((await api('GET', '/api/coordinator/stats/reviews?days=7', { token, env: ENV })).headers.get('X-Cache')).toBe('hit');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
