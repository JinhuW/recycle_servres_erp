import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS, PRIYA } from './helpers/auth';
import type { SyncResult } from '../src/banktx/sync';

// The on-demand PayPal pull that /advance and /handoff make for an unknown
// 17-character id, when the pull itself is the thing that goes wrong. The
// real sync is swapped for a scripted one here: the stub provider can only
// succeed, and these cases are about a pull that fails or that must not run.

const ZERO = { inserted: 0, updated: 0, paired: 0, autoLinked: 0, disputes: 0 };
// vi.mock is hoisted above every other statement, so what its factory closes
// over has to be hoisted with it.
const { script, syncSpy } = vi.hoisted(() => {
  const zero = { inserted: 0, updated: 0, paired: 0, autoLinked: 0, disputes: 0 };
  const script: { next: SyncResult } = {
    next: { perSource: { paypal: { ...zero } }, notConfigured: [] },
  };
  return { script, syncSpy: vi.fn(async (): Promise<SyncResult> => script.next) };
});

vi.mock('../src/banktx/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/banktx/sync')>();
  return { ...actual, syncBankTransactions: syncSpy };
});

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 2, unitCost: 60,
};
const UNKNOWN = 'NOSUCHTXN00000001';
const STUB = { BANKTX_STUB: '1' };

async function createOrder(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', warehouseId: 'WH-LA1', payment: 'company', lines: [LINE] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function setTxn(token: string, id: string, txn: string): Promise<void> {
  const r = await api('PATCH', `/api/orders/${id}`, { token, body: { paypalTxnId: txn } });
  expect(r.status).toBe(200);
}

async function lifecycleOf(token: string, id: string): Promise<string> {
  const got = await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${id}`, { token });
  return got.body.order.lifecycle;
}

// The rule is live only once a PayPal account has synced; an account row with
// no transactions leaves every id unknown.
async function seedAccountOnly(): Promise<void> {
  const sql = getTestDb();
  await sql`INSERT INTO bank_accounts (source, external_id, name) VALUES ('paypal', 'primary', 'stub')`;
}

describe('the on-demand PayPal pull', () => {
  beforeEach(async () => {
    await resetDb();
    await seedAccountOnly();
    syncSpy.mockClear();
    script.next = { perSource: { paypal: { ...ZERO } }, notConfigured: [] };
  });

  it('a pull that fails is named in the refusal, not blamed on the id', async () => {
    script.next = { perSource: { paypal: { ...ZERO, error: 'PayPal 401' } }, notConfigured: [] };
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token);
    await setTxn(token, id, UNKNOWN);

    const r = await api<{ error: string; pullFailed?: boolean; paypalTxnId: string }>(
      'POST', `/api/orders/${id}/advance`, { token, env: STUB });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/reach PayPal/i);
    expect(r.body.error).not.toMatch(/check the ID/i);
    expect(r.body.pullFailed).toBe(true);
    expect(r.body.paypalTxnId).toBe(UNKNOWN);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(await lifecycleOf(token, id)).toBe('draft');
  });

  it('the hand-off says the same thing through its own door', async () => {
    script.next = { perSource: { paypal: { ...ZERO, error: 'PayPal 401' } }, notConfigured: [] };
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token);

    const r = await api<{ error: string; pullFailed?: boolean }>('POST', `/api/orders/${id}/handoff`, {
      token, env: STUB, body: {
        warehouseId: 'WH-LA1', source: 'other', handoff: { method: 'pickup', byUserId: user.id },
        payment: 'company', paymentMethod: 'paypal', paypalTxnId: UNKNOWN,
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/reach PayPal/i);
    expect(r.body.pullFailed).toBe(true);
    expect(await lifecycleOf(token, id)).toBe('draft');
  });

  it('a pull that ran and found nothing keeps the "check the ID" refusal', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token);
    await setTxn(token, id, UNKNOWN);

    const r = await api<{ error: string; pullFailed?: boolean }>(
      'POST', `/api/orders/${id}/advance`, { token, env: STUB });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/check the ID/i);
    expect(r.body.pullFailed).toBeUndefined();
  });

  // Its own actor: the limiter is a module-level budget per user with no
  // reset, so the pulls the cases above made would otherwise count here.
  it('a user gets three pulls a minute; past that the guard judges the table as is', async () => {
    const { token } = await loginAs(PRIYA);
    const id = await createOrder(token);
    await setTxn(token, id, UNKNOWN);

    for (let i = 0; i < 4; i++) {
      const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, { token, env: STUB });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/check the ID/i);
    }
    expect(syncSpy).toHaveBeenCalledTimes(3);
    expect(await lifecycleOf(token, id)).toBe('draft');
  });
});
