import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

const NEW_PW = 'Hunter2-NewPass';

const changePw = (token: string, current: string, next: string) =>
  api<{ ok?: boolean; error?: string }>('POST', '/api/me/password', {
    token,
    body: { currentPassword: current, newPassword: next },
  });

const login = (email: string, password: string) =>
  api('POST', '/api/auth/login', { body: { email, password } });

describe('POST /api/me/password', () => {
  beforeEach(async () => { await resetDb(); });

  it('rotates the password and lets the user sign in with the new one', async () => {
    const { token } = await loginAs(ALEX);
    const r = await changePw(token, 'demo', NEW_PW);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    expect((await login(ALEX, 'demo')).status).toBe(401);
    expect((await login(ALEX, NEW_PW)).status).toBe(200);
  });

  it('rejects an incorrect current password and leaves the hash unchanged', async () => {
    const { token } = await loginAs(ALEX);
    const r = await changePw(token, 'not-the-password', NEW_PW);
    expect(r.status).toBe(403);
    expect((await login(ALEX, 'demo')).status).toBe(200);
  });

  it('rejects a new password under the minimum length', async () => {
    const { token } = await loginAs(ALEX);
    const r = await changePw(token, 'demo', 'short');
    expect(r.status).toBe(400);
  });

  it('rejects a new password identical to the current one', async () => {
    const { token } = await loginAs(ALEX);
    const r = await changePw(token, 'demo', 'demo');
    expect(r.status).toBe(400);
  });

  it('requires currentPassword and newPassword in the body', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/me/password', { token, body: {} });
    expect(r.status).toBe(400);
  });

  it('requires authentication', async () => {
    const r = await changePw('', 'demo', NEW_PW);
    expect(r.status).toBe(401);
  });

  it('preserves the calling session and revokes other refresh-token families', async () => {
    const sessA = await loginAs(ALEX);
    const sessB = await loginAs(ALEX);

    const r = await api('POST', '/api/me/password', {
      token: sessA.token,
      cookies: { rt: sessA.cookies.rt },
      body: { currentPassword: 'demo', newPassword: NEW_PW },
    });
    expect(r.status).toBe(200);

    const refreshA = await api('POST', '/api/auth/refresh', { cookies: { rt: sessA.cookies.rt } });
    expect(refreshA.status).toBe(200);

    const refreshB = await api('POST', '/api/auth/refresh', { cookies: { rt: sessB.cookies.rt } });
    expect(refreshB.status).toBe(401);
  });

  it('locks the endpoint after 5 wrong-current-password attempts', async () => {
    const { token } = await loginAs(ALEX);
    for (let i = 0; i < 5; i++) {
      expect((await changePw(token, 'wrong-' + i, NEW_PW)).status).toBe(403);
    }
    // 6th attempt is blocked even with the correct current password.
    const blocked = await changePw(token, 'demo', NEW_PW);
    expect(blocked.status).toBe(429);
  });
});
