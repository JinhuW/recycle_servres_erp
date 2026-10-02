import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const NEW_PW = 'Hunter2-NewPass';

// tokens_valid_after has whole-second resolution, the same as iat, so a token
// minted in the very second of a password change still passes. Step past that
// second so the tokens under test are unambiguously older than the change.
const nextSecond = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 20));

const me = (token: string) => api<{ error?: string }>('GET', '/api/me', { token });
const refresh = (rt: string) => api('POST', '/api/auth/refresh', { cookies: { rt } });

describe('access tokens die with the password', () => {
  beforeEach(async () => { await resetDb(); });

  it('a self change ends every access token, and the caller refreshes back in', async () => {
    const caller = await loginAs(ALEX);
    const other = await loginAs(ALEX);
    await nextSecond();

    const r = await api('POST', '/api/me/password', {
      token: caller.token,
      body: { currentPassword: 'demo', newPassword: NEW_PW },
    });
    expect(r.status).toBe(200);
    // No re-issued cookies: they would overwrite an `rt` this path never sees.
    expect(r.setCookies.at).toBeUndefined();
    expect(r.setCookies.rt).toBeUndefined();

    const stale = await me(caller.token);
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe('Session expired');
    expect((await me(other.token)).status).toBe(401);

    // The caller kept its refresh family, so the SPA's 401 → refresh lands.
    const back = await refresh(caller.cookies.rt);
    expect(back.status).toBe(200);
    expect((await me(back.setCookies.at)).status).toBe(200);

    // Every other session is gone for good.
    expect((await refresh(other.cookies.rt)).status).toBe(401);
  });

  it('a manager reset ends the member’s access tokens and refresh families', async () => {
    const target = await loginAs(MARCUS);
    const manager = await loginAs(ALEX);
    await nextSecond();

    const r = await api('PATCH', `/api/members/${target.user.id}`, {
      token: manager.token,
      body: { password: NEW_PW },
    });
    expect(r.status).toBe(200);

    expect((await me(target.token)).status).toBe(401);
    expect((await refresh(target.cookies.rt)).status).toBe(401);
    // The manager's own session is untouched.
    expect((await me(manager.token)).status).toBe(200);

    const fresh = await loginAs(MARCUS, NEW_PW);
    expect((await me(fresh.token)).status).toBe(200);
  });

  it('leaves tokens alone for a member whose password never changed', async () => {
    const { token, user } = await loginAs(MARCUS);
    const [row] = await getTestDb()<{ tokens_valid_after: Date | null }[]>`
      SELECT tokens_valid_after FROM users WHERE id = ${user.id}
    `;
    expect(row.tokens_valid_after).toBeNull();
    expect((await me(token)).status).toBe(200);
  });

  it('a metadata-only member edit does not end sessions', async () => {
    const target = await loginAs(MARCUS);
    const manager = await loginAs(ALEX);
    await nextSecond();

    const r = await api('PATCH', `/api/members/${target.user.id}`, {
      token: manager.token,
      body: { title: 'Senior Buyer' },
    });
    expect(r.status).toBe(200);
    expect((await me(target.token)).status).toBe(200);
    expect((await refresh(target.cookies.rt)).status).toBe(200);
  });
});
