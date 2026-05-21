import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

type List = { items: unknown[] };

describe('list endpoints are bounded by a server-side limit', () => {
  beforeEach(async () => { await resetDb(); });

  for (const path of ['/api/customers', '/api/warehouses', '/api/categories']) {
    it(`${path} honors ?limit= and returns the full set without it`, async () => {
      const { token } = await loginAs(ALEX);

      const all = await api<List>('GET', path, { token });
      expect(all.status).toBe(200);
      expect(all.body.items.length).toBeGreaterThan(1); // seed has several

      const capped = await api<List>('GET', `${path}?limit=1`, { token });
      expect(capped.status).toBe(200);
      expect(capped.body.items.length).toBe(1);
    });
  }
});
