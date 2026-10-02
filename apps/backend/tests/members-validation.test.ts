import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_PASSWORD_LEN } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
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

  it('rejects a password over the maximum length, on create and on PATCH', async () => {
    const { token } = await loginAs(ALEX);
    const long = 'x'.repeat(MAX_PASSWORD_LEN + 1);
    const create = await api('POST', '/api/members', { token, body: { ...valid, password: long } });
    expect(create.status).toBe(400);
    expect(JSON.stringify(create.body)).toMatch(/password/i);

    const created = await api<{ id: string }>('POST', '/api/members', { token, body: valid });
    const patch = await api('PATCH', `/api/members/${created.body.id}`, { token, body: { password: long } });
    expect(patch.status).toBe(400);
  });

  // Postgres would read the string 'false' as false, slipping past the
  // lockout guards and the session revoke that key on a real boolean.
  it('rejects a non-boolean active on PATCH and leaves the member active', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/members', { token, body: valid });
    const r = await api('PATCH', `/api/members/${created.body.id}`, { token, body: { active: 'false' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/active/i);
    const [row] = await getTestDb()<{ active: boolean }[]>`
      SELECT active FROM users WHERE id = ${created.body.id}
    `;
    expect(row.active).toBe(true);
  });

  it('rejects non-string name, team, phone and title', async () => {
    const { token } = await loginAs(ALEX);
    expect((await api('POST', '/api/members', { token, body: { ...valid, name: ['Bie'] } })).status)
      .toBe(400);
    const created = await api<{ id: string }>('POST', '/api/members', { token, body: valid });
    for (const field of ['name', 'team', 'phone', 'title']) {
      const r = await api('PATCH', `/api/members/${created.body.id}`, { token, body: { [field]: 42 } });
      expect(r.status, field).toBe(400);
      expect(JSON.stringify(r.body)).toContain(field);
    }
  });

  it('still accepts null for an optional text field (leaves it unchanged)', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/members', {
      token, body: { ...valid, phone: '303-555-0100' },
    });
    const r = await api('PATCH', `/api/members/${created.body.id}`, { token, body: { phone: null } });
    expect(r.status).toBe(200);
    const [row] = await getTestDb()<{ phone: string | null }[]>`
      SELECT phone FROM users WHERE id = ${created.body.id}
    `;
    expect(row.phone).toBe('303-555-0100');
  });

  it('stores the email trimmed and lowercased, so the member can sign in', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<{ id: string; password: string }>('POST', '/api/members', {
      token, body: { ...valid, email: '  NewBie@RecycleServers.IO ' },
    });
    expect(created.status).toBe(201);
    const [row] = await getTestDb()<{ email: string }[]>`
      SELECT email FROM users WHERE id = ${created.body.id}
    `;
    expect(row.email).toBe('newbie@recycleservers.io');
    const login = await api('POST', '/api/auth/login', {
      body: { email: 'newbie@recycleservers.io', password: created.body.password },
    });
    expect(login.status).toBe(200);
  });
});
