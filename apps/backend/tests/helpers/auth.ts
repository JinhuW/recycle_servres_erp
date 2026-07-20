import { api } from './app';

export type LoginResult = {
  token: string;
  user: { id: string; role: string; email: string };
  cookies: Record<string, string>;
};

export async function loginAs(email: string, password = 'demo'): Promise<LoginResult> {
  const r = await api<{ user: { id: string; role: string; email: string } }>(
    'POST',
    '/api/auth/login',
    { body: { email, password }, headers: { 'X-Requested-By': 'recycle-erp' } },
  );
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  // Backend is cookie-only: there is no token in the body. Bridge the legacy
  // `token` field to the access-cookie value so existing suites that do
  // `const { token } = await loginAs()` keep working unchanged.
  return { token: r.setCookies.at ?? '', user: r.body.user, cookies: r.setCookies };
}

export const ALEX = 'alex@recycleservers.io';        // manager
export const SOFIA = 'sofia@recycleservers.io';      // manager
export const MARCUS = 'marcus@recycleservers.io';    // purchaser
export const PRIYA = 'priya@recycleservers.io';      // purchaser
