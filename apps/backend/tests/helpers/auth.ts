import { api } from './app';

export type LoginResult = { token: string; user: { id: string; role: string; email: string } };

export async function loginAs(email: string, password = 'demo'): Promise<LoginResult> {
  const r = await api<LoginResult>('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const ALEX = 'alex@recycleservers.io';        // manager
export const MARCUS = 'marcus@recycleservers.io';    // purchaser
export const PRIYA = 'priya@recycleservers.io';      // purchaser
