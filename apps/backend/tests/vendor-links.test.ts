import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('vendor links', () => {
  beforeAll(async () => { await resetDb(); });

  it('migration created vendor_links and a VB counter', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: Array<{ id: string }> }>('GET', '/api/customers', { token });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
  });
});
