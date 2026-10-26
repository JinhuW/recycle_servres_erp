import { describe, expect, it } from 'vitest';
import { createGetDedupe } from './sharedGet';

// A fetcher whose answers the test releases by hand, counting the requests.
function fakeFetch() {
  const calls: string[] = [];
  const pending: { path: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const fetchGet = (path: string) => new Promise((resolve, reject) => {
    calls.push(path);
    pending.push({ path, resolve, reject });
  });
  return { calls, pending, fetchGet };
}

describe('createGetDedupe', () => {
  it('shares one request between callers while it is in flight', async () => {
    const f = fakeFetch();
    const d = createGetDedupe(f.fetchGet, 2_000, () => 0);
    const a = d.get('/api/coordinator/fleet');
    const b = d.get('/api/coordinator/fleet');
    expect(f.calls).toEqual(['/api/coordinator/fleet']);
    f.pending[0].resolve({ workers: [] });
    expect(await a).toBe(await b);
  });

  it('keeps an answer for the window, then reads again', async () => {
    const f = fakeFetch();
    let now = 1_000;
    const d = createGetDedupe(f.fetchGet, 2_000, () => now);
    const first = d.get('/api/fleet/slots');
    f.pending[0].resolve({ slots: [1] });
    await first;
    now += 1_999;
    expect(await d.get('/api/fleet/slots')).toEqual({ slots: [1] });
    expect(f.calls).toHaveLength(1);
    now += 1;
    void d.get('/api/fleet/slots');
    expect(f.calls).toHaveLength(2);
  });

  it('keys by the whole URL, query included', () => {
    const f = fakeFetch();
    const d = createGetDedupe(f.fetchGet, 2_000, () => 0);
    void d.get('/api/fleet/tasks?state=ready');
    void d.get('/api/fleet/tasks?state=done');
    void d.get('/api/fleet/tasks?state=ready');
    expect(f.calls).toEqual(['/api/fleet/tasks?state=ready', '/api/fleet/tasks?state=done']);
  });

  it('never remembers a failure', async () => {
    const f = fakeFetch();
    const d = createGetDedupe(f.fetchGet, 2_000, () => 0);
    const a = d.get('/api/coordinator/challenges?status=open');
    const b = d.get('/api/coordinator/challenges?status=open');
    f.pending[0].reject(new Error('502'));
    await expect(a).rejects.toThrow('502');
    await expect(b).rejects.toThrow('502');
    void d.get('/api/coordinator/challenges?status=open');
    expect(f.calls).toHaveLength(2);
  });

  it('reads again after forget, and an answer from before it is not kept', async () => {
    const f = fakeFetch();
    const d = createGetDedupe(f.fetchGet, 2_000, () => 0);
    const before = d.get('/api/fleet/hosts');
    d.forget();
    const after = d.get('/api/fleet/hosts');
    expect(f.calls).toHaveLength(2);
    f.pending[0].resolve('old');
    f.pending[1].resolve('new');
    expect(await before).toBe('old');
    expect(await after).toBe('new');
    expect(await d.get('/api/fleet/hosts')).toBe('new');
    expect(f.calls).toHaveLength(2);
  });
});
