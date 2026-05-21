import { describe, it, expect } from 'vitest';
import app from '../src/index';
import { testEnv } from './helpers/app';

// Regression: a global 1 MiB body cap should reject oversized JSON payloads on
// non-upload routes before auth / route handlers process them.
describe('global JSON body-size limit', () => {
  const OVER_1MIB_SIZE = 1_048_577; // 1 MiB + 1 byte

  it('rejects a POST body over 1 MiB with 413 on a JSON route', async () => {
    // Build a body that is exactly over the 1 MiB threshold.
    // Wrap in a valid JSON object so Content-Type: application/json is honest.
    const bigValue = 'x'.repeat(OVER_1MIB_SIZE);
    const payload = JSON.stringify({ x: bigValue }); // > 1 MiB

    const res = await app.fetch(
      new Request('http://test/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-By': 'recycle-erp',
        },
        body: payload,
      }),
      testEnv,
    );
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Payload too large');
  });

  it('accepts a POST body under 1 MiB on a JSON route (passes through to route logic)', async () => {
    // A normal-sized login attempt — wrong credentials, but NOT a 413.
    const payload = JSON.stringify({ email: 'nobody@example.com', password: 'wrong' });
    const res = await app.fetch(
      new Request('http://test/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-By': 'recycle-erp',
        },
        body: payload,
      }),
      testEnv,
    );
    expect(res.status).not.toBe(413);
  });
});
