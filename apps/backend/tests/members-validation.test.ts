import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('member create/update input validation', () => {
  beforeEach(async () => { await resetDb(); });

  const valid = { email: 'newbie@recycleservers.io', name: 'New Bie', role: 'purchaser' };

  it('rejects an unknown role', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/members', { token, body: { ...valid, role: 'superadmin' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/role/i);
  });

  it('rejects a malformed email', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/members', { token, body: { ...valid, email: 'not-an-email' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/email/i);
  });

  it('rejects a too-short explicit password', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/members', { token, body: { ...valid, password: 'short' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/password/i);
  });

  it('accepts a valid member (no password → temp generated)', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ id: string; password: string }>('POST', '/api/members', { token, body: valid });
    expect(r.status).toBe(201);
    expect(r.body.password.length).toBeGreaterThanOrEqual(8);
  });

  it('rejects an unknown role on PATCH', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/members', { token, body: valid });
    const r = await api('PATCH', `/api/members/${created.body.id}`, { token, body: { role: 'root' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/role/i);
  });

  it('rejects a too-short password on PATCH', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/members', { token, body: valid });
    const r = await api('PATCH', `/api/members/${created.body.id}`, { token, body: { password: 'abc' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/password/i);
  });
});
