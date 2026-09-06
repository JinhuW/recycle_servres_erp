import { describe, it, expect } from 'vitest';
import { createBeacon, type Post } from './beacon';

// A stand-in transport. `statuses` is consumed one call at a time so a test can
// say "401, then 204" and assert on what the second call carried.
function transport(...statuses: number[]) {
  const calls: { path: string; body: unknown; init?: { keepalive?: boolean } }[] = [];
  let i = 0;
  const post: Post = (path, body, init) => {
    calls.push({ path, body, init });
    const status = statuses[i] ?? statuses[statuses.length - 1] ?? 204;
    i++;
    return Promise.resolve({ status });
  };
  return { post, calls };
}

// The queue resolves promises internally, so let the microtask queue drain
// before asserting on what it did with the result.
const settled = () => new Promise((r) => setTimeout(r, 0));

describe('beacon', () => {
  it('holds nothing when the report is accepted', async () => {
    const { post, calls } = transport(204);
    const b = createBeacon(post);
    b.send('/api/client-timings', { loadEvent: 900 });
    await settled();
    expect(calls).toHaveLength(1);
    expect(b.size).toBe(0);
  });

  it('holds a 401 and re-sends the original payload once a session exists', async () => {
    const { post, calls } = transport(401, 204);
    const b = createBeacon(post);
    b.send('/api/client-timings', { loadEvent: 900, apiCalls: 4 }, { keepalive: true });
    await settled();
    expect(b.size).toBe(1);

    b.flush();
    await settled();
    expect(calls).toHaveLength(2);
    // The numbers describe the load that was measured, not the one that was
    // running when the session finally arrived.
    expect(calls[1].body).toEqual({ loadEvent: 900, apiCalls: 4 });
    expect(calls[1].init).toEqual({ keepalive: true });
    expect(b.size).toBe(0);
  });

  it('re-sends immediately when the session landed while the report was in flight', async () => {
    // The race: a password manager submits inside the round trip, so flush()
    // runs before the 401 comes back. Queueing here would strand the report for
    // the life of the tab, because the event it is waiting for has fired.
    const { post, calls } = transport(401, 204);
    const b = createBeacon(post);
    b.send('/api/client-errors', { message: 'boom' });
    b.flush();
    await settled();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ message: 'boom' });
    expect(b.size).toBe(0);
  });

  it('drops a re-send that 401s again rather than re-queueing it', async () => {
    const { post, calls } = transport(401, 401);
    const b = createBeacon(post);
    b.send('/api/client-errors', { message: 'boom' });
    await settled();
    b.flush();
    await settled();
    expect(calls).toHaveLength(2);
    // Nothing held: a later login must not retry this forever.
    expect(b.size).toBe(0);
  });

  it('caps what a never-logged-in tab can accumulate', async () => {
    const { post } = transport(401);
    const b = createBeacon(post);
    for (let i = 0; i < 12; i++) {
      b.send('/api/client-errors', { message: `boom ${i}` });
      await settled();
    }
    expect(b.size).toBe(5);
  });

  it('swallows a network rejection without holding anything', async () => {
    const b = createBeacon(() => Promise.reject(new Error('offline')));
    b.send('/api/client-timings', { loadEvent: 900 });
    await settled();
    expect(b.size).toBe(0);
  });

  it('flushes nothing when nothing was held', async () => {
    const { post, calls } = transport(204);
    const b = createBeacon(post);
    b.flush();
    await settled();
    expect(calls).toHaveLength(0);
  });
});
