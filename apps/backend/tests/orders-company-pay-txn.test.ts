import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import { stubPaypalProvider } from '../src/banktx/stub';

// "A company-paid PO must carry a payment transaction id before it can leave
// Draft" — enforced in advanceOrderTx, so every caller is covered, and scoped
// by the migration-0115 cutoff so orders that predate the rule stay exempt.
// Its self-paid twin (0126): the chat with the seller, as a Submission
// attachment, before the order leaves Draft.

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chat.png', { type: 'image/png' });

async function attachChat(token: string, id: string): Promise<void> {
  const up = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
    { file: PNG() }, { token });
  expect(up.status).toBe(200);
}

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 2, unitCost: 60,
};

async function createOrder(token: string, payment: 'company' | 'self'): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', warehouseId: 'WH-LA1', payment, lines: [LINE] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function lifecycleOf(token: string, id: string): Promise<string> {
  const got = await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${id}`, { token });
  return got.body.order.lifecycle;
}

describe('company-pay POs need a transaction ID to leave Draft', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses the advance and leaves the PO in Draft', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');

    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/transaction ID/i);
    expect(await lifecycleOf(token, id)).toBe('draft');
  });

  it('advances once the transaction ID is saved', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');

    const patched = await api('PATCH', `/api/orders/${id}`, {
      token, body: { paypalTxnId: '7AB12345CD678901E' },
    });
    expect(patched.status).toBe(200);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
  });

  it('never asks a self-pay PO for a transaction ID', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    await attachChat(token, id);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
  });

  it('lifts the rule when the company paid in cash', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    const sql = getTestDb();
    await sql`UPDATE orders SET payment_method = 'cash' WHERE id = ${id}`;

    const got = await api<{ order: { txnRequired: boolean } }>(
      'GET', `/api/orders/${id}`, { token });
    expect(got.body.order.txnRequired).toBe(false);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
  });

  it('holds a manager stage-jump to the same rule', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await createOrder(pTok, 'company');

    const { token: mTok } = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, {
      token: mTok, body: { toStage: 'done' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/transaction ID/i);
    expect(await lifecycleOf(mTok, id)).toBe('draft');
  });

  it('exempts a PO created before the cutoff', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');

    // The cutoff is stamped when 0115 runs, i.e. when this worker's template
    // was built — so backdating the order is what puts it on the old side.
    const sql = getTestDb();
    await sql`UPDATE orders SET created_at = NOW() - INTERVAL '30 days' WHERE id = ${id}`;

    const got = await api<{ order: { txnRequired: boolean } }>(
      'GET', `/api/orders/${id}`, { token });
    expect(got.body.order.txnRequired).toBe(false);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
  });

  it('reports txnRequired so the shells can refuse before the round-trip', async () => {
    const { token } = await loginAs(MARCUS);
    const company = await createOrder(token, 'company');
    const self = await createOrder(token, 'self');

    const a = await api<{ order: { txnRequired: boolean } }>(
      'GET', `/api/orders/${company}`, { token });
    expect(a.body.order.txnRequired).toBe(true);

    const b = await api<{ order: { txnRequired: boolean } }>(
      'GET', `/api/orders/${self}`, { token });
    expect(b.body.order.txnRequired).toBe(false);
  });
});

// "…and it must be one of our PayPal account's transactions" — the id is
// checked against the synced PayPal rows in bank_transactions, at the same
// door. The rule is live only once a PayPal account has synced into the
// environment, which is why the block above passes any id at all.
describe('company-pay POs need a transaction ID we synced from PayPal', () => {
  beforeEach(async () => { await resetDb(); });

  // The stub provider's canned rows, no PayPal keys needed.
  const KNOWN = '7AB12345CD678901E';
  const UNKNOWN = 'NOSUCHTXN00000001';

  async function seedPaypal(): Promise<void> {
    await syncBankTransactions(testEnv, [stubPaypalProvider()]);
  }

  async function setTxn(token: string, id: string, txn: string): Promise<void> {
    const r = await api('PATCH', `/api/orders/${id}`, { token, body: { paypalTxnId: txn } });
    expect(r.status).toBe(200);
  }

  it('refuses an ID that is not among the synced PayPal transactions', async () => {
    await seedPaypal();
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    await setTxn(token, id, UNKNOWN);

    const r = await api<{ error: string; paypalTxnId: string }>(
      'POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/PayPal account/i);
    expect(r.body.paypalTxnId).toBe(UNKNOWN);
    expect(await lifecycleOf(token, id)).toBe('draft');
  });

  it('advances on an ID that a synced PayPal row carries', async () => {
    await seedPaypal();
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    await setTxn(token, id, KNOWN);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
  });

  it('holds a manager stage-jump to the same rule', async () => {
    await seedPaypal();
    const { token: pTok } = await loginAs(MARCUS);
    const id = await createOrder(pTok, 'company');
    await setTxn(pTok, id, UNKNOWN);

    const { token: mTok } = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, {
      token: mTok, body: { toStage: 'done' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/PayPal account/i);
    expect(await lifecycleOf(mTok, id)).toBe('draft');
  });

  it('is off until a PayPal account has synced into the environment', async () => {
    // No sync at all: the table is empty, as on a dev box without PayPal
    // keys, and any id passes — the case every other test file relies on.
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    await setTxn(token, id, UNKNOWN);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
  });

  // An account has synced but the payment has not arrived yet — the
  // six-hourly gap. Whether the advance pulls PayPal first depends on whether
  // PayPal is configured; two orders, because the one that advanced is no
  // longer a Draft to refuse.
  async function seedAccountOnly(): Promise<void> {
    const sql = getTestDb();
    await sql`INSERT INTO bank_accounts (source, external_id, name) VALUES ('paypal', 'primary', 'stub')`;
  }

  it('refuses without pulling when PayPal is not configured', async () => {
    await seedAccountOnly();
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    await setTxn(token, id, KNOWN);

    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/PayPal account/i);
    expect(await lifecycleOf(token, id)).toBe('draft');
  });

  it('pulls PayPal once before deciding when it is configured', async () => {
    await seedAccountOnly();
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    await setTxn(token, id, KNOWN);

    const r = await api('POST', `/api/orders/${id}/advance`, {
      token, env: { BANKTX_STUB: '1' },
    });
    expect(r.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
    const sql = getTestDb();
    const rows = await sql`
      SELECT 1 FROM bank_transactions WHERE source = 'paypal' AND paypal_txn_id = ${KNOWN}`;
    expect(rows.length).toBe(1);
  });
});

describe('self-pay POs need the chat with the seller to leave Draft', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses the advance until a Submission attachment exists', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');

    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/chat history/i);
    expect(await lifecycleOf(token, id)).toBe('draft');

    await attachChat(token, id);
    const again = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(again.status).toBe(200);
    expect(await lifecycleOf(token, id)).toBe('in_transit');
  });

  it('holds a manager stage-jump to the same rule', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await createOrder(pTok, 'self');

    const { token: mTok } = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, {
      token: mTok, body: { toStage: 'reviewing' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/chat history/i);
    expect(await lifecycleOf(mTok, id)).toBe('draft');
  });

  it('exempts a PO created before the cutoff, and says so', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    const sql = getTestDb();
    await sql`UPDATE orders SET created_at = NOW() - INTERVAL '30 days' WHERE id = ${id}`;

    const got = await api<{ order: { chatShotRequired: boolean } }>(
      'GET', `/api/orders/${id}`, { token });
    expect(got.body.order.chatShotRequired).toBe(false);

    const r = await api('POST', `/api/orders/${id}/advance`, { token });
    expect(r.status).toBe(200);
  });

  it('reports chatShotRequired so the shells can refuse before the round-trip', async () => {
    const { token } = await loginAs(MARCUS);
    const self = await createOrder(token, 'self');
    const company = await createOrder(token, 'company');

    const a = await api<{ order: { chatShotRequired: boolean } }>(
      'GET', `/api/orders/${self}`, { token });
    expect(a.body.order.chatShotRequired).toBe(true);
    const b = await api<{ order: { chatShotRequired: boolean } }>(
      'GET', `/api/orders/${company}`, { token });
    expect(b.body.order.chatShotRequired).toBe(false);
  });
});
