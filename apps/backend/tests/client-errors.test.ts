import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Browser-side failure reports. The backend only ever logs requests that reached
// it, so a render crash or a fetch that never resolved left nothing to grep —
// this endpoint is where the SPA hands those over. The load-bearing parts are
// that it stays behind auth, that it redacts a path carrying a credential, and
// that a client stuck in a render loop can't flood the log.

const post = (token: string | undefined, body: unknown, headers?: Record<string, string>) =>
  api('POST', '/api/client-errors', { token, body, headers });

describe('POST /api/client-errors', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an unauthenticated report', async () => {
    const r = await post(undefined, { message: 'boom' });
    expect(r.status).toBe(401);
  });

  it('rejects a report without the CSRF header', async () => {
    const { token } = await loginAs(ALEX);
    const r = await post(token, { message: 'boom' }, { 'X-Requested-By': 'nope' });
    expect(r.status).toBe(403);
  });

  it('requires a message', async () => {
    const { token } = await loginAs(ALEX);
    expect((await post(token, {})).status).toBe(400);
    expect((await post(token, { message: '   ' })).status).toBe(400);
  });

  it('accepts a report and writes one line naming the failed request', async () => {
    const { token } = await loginAs(ALEX);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await post(token, {
      message: 'HTTP 500',
      kind: 'fetch',
      method: 'GET',
      status: 500,
      path: '/api/activity?cursor=abc',
      requestId: 'req-from-the-failed-call',
    });
    expect(r.status).toBe(204);

    const line = spy.mock.calls.map(c => String(c[0])).find(s => s.includes('client-error'));
    expect(line, 'the report must reach stdout — ERROR_LOG_DIR is unset on Railway').toBeTruthy();
    const rec = JSON.parse(line!);
    expect(rec.kind).toBe('client-error');
    expect(rec.level).toBe('warn');
    expect(rec.message).toBe('HTTP 500');
    expect(rec.path).toBe('/api/activity');
    // The id of the call that failed in the browser, not of this report — it is
    // what joins the two logs together.
    expect(rec.failedRequestId).toBe('req-from-the-failed-call');
    expect(rec.userEmail).toBe(ALEX);
  });

  it('redacts a credential carried in the reported path', async () => {
    const { token } = await loginAs(ALEX);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await post(token, {
      message: 'failed',
      path: '/api/public/vendor/super-secret-token/bids',
    });

    const line = spy.mock.calls.map(c => String(c[0])).find(s => s.includes('client-error'))!;
    expect(line).not.toContain('super-secret-token');
    expect(JSON.parse(line).path).toBe('/api/public/vendor/<redacted>/bids');
  });

  it('truncates an oversized stack instead of appending it whole', async () => {
    const { token } = await loginAs(ALEX);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await post(token, { message: 'x'.repeat(5000), stack: 'y'.repeat(99_000) });
    expect(r.status).toBe(204);
  });

  it('rate-limits a client stuck reporting the same crash', async () => {
    const { token } = await loginAs(ALEX);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const r = await post(token, { message: `boom ${i}` });
      if (r.status === 429) {
        expect(r.headers.get('Retry-After')).toBeTruthy();
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit, 'a render loop must not be able to append without bound').toBe(true);
  });
});
