import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { ALEX } from './helpers/auth';

const login = (email: string, password: string) =>
  api<{ error?: string; token?: string }>('POST', '/api/auth/login', { body: { email, password } });

describe('login brute-force throttle', () => {
  beforeEach(async () => { await resetDb(); });

  it('locks the account after 5 failed attempts, even with the correct password', async () => {
    for (let i = 0; i < 5; i++) {
      const bad = await login(ALEX, 'wrong-password');
      expect(bad.status).toBe(401);
    }
    // 6th attempt is rejected pre-verification, even though the password is right.
    const blocked = await login(ALEX, 'demo');
    expect(blocked.status).toBe(429);
  });

  // A locked email is refused on a read: a flood against it writes nothing.
  it('writes no attempt row while the email is locked', async () => {
    for (let i = 0; i < 5; i++) expect((await login(ALEX, 'wrong-password')).status).toBe(401);
    const count = async () => (await getTestDb()<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM login_attempts WHERE email = ${ALEX}`)[0].n;
    const before = await count();
    for (let i = 0; i < 5; i++) expect((await login(ALEX, 'wrong-password')).status).toBe(429);
    expect(await count()).toBe(before);
  });

  it('does not throttle a normal successful login', async () => {
    const r = await login(ALEX, 'demo');
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie') ?? '').toMatch(/(^|[ ,;])at=/);
  });

  it('a successful login resets the failure counter', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await login(ALEX, 'wrong-password')).status).toBe(401);
    }
    expect((await login(ALEX, 'demo')).status).toBe(200); // success clears the streak
    // Three more failures should be allowed again (counter reset by the success).
    for (let i = 0; i < 3; i++) {
      expect((await login(ALEX, 'wrong-password')).status).toBe(401);
    }
  });
});

describe('login throttle under concurrency and per address', () => {
  beforeEach(async () => { await resetDb(); });

  // Counting before recording let a whole burst through: every request saw
  // fewer than five failures because none had been written yet.
  it('lets at most five guesses of a burst reach the password check', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login(ALEX, 'wrong-password')),
    );
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    expect(results.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    const sql = getTestDb();
    const [{ pending, failed }] = await sql<{ pending: number; failed: number }[]>`
      SELECT COUNT(*) FILTER (WHERE success IS NULL)::int AS pending,
             COUNT(*) FILTER (WHERE success = FALSE)::int AS failed
      FROM login_attempts WHERE email = ${ALEX}
    `;
    expect(pending).toBe(0);
    expect(failed).toBeLessThanOrEqual(5);
  });

  it('locks an address that keeps failing across different emails', async () => {
    const from = (email: string) => api('POST', '/api/auth/login', {
      body: { email, password: 'x' }, headers: { 'X-Client-IP': '203.0.113.50' },
    });
    for (let i = 0; i < 30; i++) expect((await from(`nobody${i}@example.com`)).status).toBe(401);
    expect((await from('nobody-else@example.com')).status).toBe(429);
    // Without the Worker's header the address is a shared Cloudflare one, so
    // no per-address budget applies.
    expect((await login('another@example.com', 'x')).status).toBe(401);
  });
});
