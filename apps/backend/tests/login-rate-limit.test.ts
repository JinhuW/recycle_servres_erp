import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
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
