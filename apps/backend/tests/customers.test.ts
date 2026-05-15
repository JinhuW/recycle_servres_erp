import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('customers route — structured contact/address', () => {
  beforeAll(async () => { await resetDb(); });

  it('creates and reads a customer with the new fields', async () => {
    const { token } = await loginAs(ALEX);

    const created = await api<{ id: string }>('POST', '/api/customers', {
      token,
      body: {
        name: 'Test Co', shortName: 'TestCo',
        contactName: 'Jane Doe', contactEmail: 'jane@test.co',
        contactPhone: '+1-555-0100', address: '1 Test St\nTestville',
        country: 'United States', region: 'US-East',
      },
    });
    expect(created.status).toBe(201);

    const list = await api<{ items: Array<Record<string, unknown>> }>(
      'GET', '/api/customers', { token },
    );
    expect(list.status).toBe(200);
    const row = list.body.items.find(c => c.id === created.body.id)!;
    expect(row.contact_name).toBe('Jane Doe');
    expect(row.contact_email).toBe('jane@test.co');
    expect(row.contact_phone).toBe('+1-555-0100');
    expect(row.address).toBe('1 Test St\nTestville');
    expect(row.country).toBe('United States');
    expect(row).not.toHaveProperty('terms');
    expect(row).not.toHaveProperty('credit_limit');
    expect(row).not.toHaveProperty('contact');
  });

  it('patches contact fields', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: Array<{ id: string }> }>('GET', '/api/customers', { token });
    const target = list.body.items[0].id;

    const patched = await api('PATCH', `/api/customers/${target}`, {
      token, body: { contactPhone: '+1-555-9999' },
    });
    expect(patched.status).toBe(200);

    const after = await api<{ items: Array<Record<string, unknown>> }>('GET', '/api/customers', { token });
    const row = after.body.items.find(c => c.id === target)!;
    expect(row.contact_phone).toBe('+1-555-9999');
  });
});
