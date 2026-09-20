import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// How the purchaser was paid their commission: PUT /commission-payment for
// the method and PayPal id, and the 'Commission' status-meta bucket for the
// screenshot, which comes back with a transaction-id scan the client may
// apply. Manager-only, open at every stage, gates nothing.

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200',
  partNumber: 'PO-COMM-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
};

async function createOrder(token: string, opts: { advance?: boolean } = {}): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', lines: [LINE] },
  });
  expect(r.status).toBe(201);
  // Audit events are gated on lifecycle !== 'draft'.
  if (opts.advance !== false) {
    const adv = await api('POST', `/api/orders/${r.body.id}/advance`, { token });
    expect(adv.status).toBe(200);
  }
  return r.body.id;
}

type OrderJson = {
  commissionMethod: 'paypal' | 'cash' | null;
  commissionTxnId: string | null;
  statusMeta: Record<string, { attachments: { id: string; filename: string }[] }>;
};
async function getOrder(token: string, id: string): Promise<OrderJson> {
  const r = await api<{ order: OrderJson }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order;
}

async function metaChanges(token: string, id: string) {
  const r = await api<{ events: Array<{ kind: string; detail: { changes?: Array<{ field: string; from: unknown; to: unknown }> } }> }>(
    'GET', `/api/orders/${id}/events`, { token });
  expect(r.status).toBe(200);
  return r.body.events.filter(e => e.kind === 'meta_changed').flatMap(e => e.detail.changes ?? []);
}

const put = (token: string, id: string, body: unknown) =>
  api<{ ok: true; commissionMethod: string | null; commissionTxnId: string | null }>(
    'PUT', `/api/orders/${id}/commission-payment`, { token, body });

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'paid.png', { type: 'image/png' });

describe('PUT /api/orders/:id/commission-payment', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager records the method and id; GET reflects them and the change is audited', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);
    expect((await getOrder(mgr, id)).commissionMethod).toBeNull();

    const r = await put(mgr, id, { method: 'paypal', txnId: ' 7ab12345cd 678901e ' });
    expect(r.status).toBe(200);
    expect(r.body.commissionMethod).toBe('paypal');
    expect(r.body.commissionTxnId).toBe('7AB12345CD678901E');

    const o = await getOrder(mgr, id);
    expect(o.commissionMethod).toBe('paypal');
    expect(o.commissionTxnId).toBe('7AB12345CD678901E');

    const changes = await metaChanges(mgr, id);
    expect(changes).toContainEqual({ field: 'commission_method', from: null, to: 'paypal' });
    expect(changes).toContainEqual({ field: 'commission_txn_id', from: null, to: '7AB12345CD678901E' });
  });

  it('switching to cash keeps the id; a blank id clears it; an unchanged write leaves no event', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);
    expect((await put(mgr, id, { method: 'paypal', txnId: 'ABC123' })).status).toBe(200);

    expect((await put(mgr, id, { method: 'cash' })).status).toBe(200);
    let o = await getOrder(mgr, id);
    expect(o.commissionMethod).toBe('cash');
    expect(o.commissionTxnId).toBe('ABC123');

    const before = (await metaChanges(mgr, id)).length;
    expect((await put(mgr, id, { method: 'cash' })).status).toBe(200);
    expect((await metaChanges(mgr, id)).length).toBe(before);

    expect((await put(mgr, id, { txnId: '  ' })).status).toBe(200);
    o = await getOrder(mgr, id);
    expect(o.commissionTxnId).toBeNull();
  });

  it('writes on a closed book — the commission is paid once the PO is Done', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);
    await getTestDb()`UPDATE orders SET lifecycle = 'done' WHERE id = ${id}`;

    expect((await put(mgr, id, { method: 'paypal', txnId: 'DONE1' })).status).toBe(200);
    expect((await getOrder(mgr, id)).commissionTxnId).toBe('DONE1');
  });

  it('refuses purchasers (403), empty or malformed bodies (400), an over-long id (400) and a missing order (404)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: buyer } = await loginAs(MARCUS);
    const id = await createOrder(mgr);

    expect((await put(buyer, id, { method: 'paypal' })).status).toBe(403);
    expect((await put(mgr, id, {})).status).toBe(400);
    expect((await put(mgr, id, { method: 'venmo' })).status).toBe(400);
    expect((await put(mgr, id, { method: null })).status).toBe(400);
    expect((await put(mgr, id, { txnId: 42 })).status).toBe(400);
    expect((await put(mgr, id, { txnId: 'X'.repeat(65) })).status).toBe(400);
    expect((await put(mgr, 'PO-999999', { method: 'cash' })).status).toBe(404);
  });
});

describe('Commission screenshots', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager uploads one; it is read for a PayPal id but the id is not written', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);

    const up = await multipart(`/api/orders/${id}/status-meta/Commission/attachments`,
      { file: PNG() }, { token: mgr });
    expect(up.status).toBe(200);
    const body = up.body as {
      attachment: { id: string; filename: string };
      scan: { txnId: string | null; confidence: number; provider: string } | null;
    };
    expect(body.attachment.filename).toBe('paid.png');
    // No OPENROUTER_API_KEY in tests → the deterministic stub.
    expect(body.scan?.provider).toBe('stub');
    expect(body.scan?.txnId).toBe('7AB12345CD678901E');

    const o = await getOrder(mgr, id);
    expect(o.statusMeta.Commission.attachments.map(a => a.id)).toEqual([body.attachment.id]);
    expect(o.commissionTxnId).toBeNull();
  });

  it('the other buckets keep their shape — no scan on a Payment upload', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);
    const up = await multipart(`/api/orders/${id}/status-meta/Payment/attachments`,
      { file: PNG() }, { token: mgr });
    expect(up.status).toBe(200);
    expect('scan' in (up.body as object)).toBe(false);
  });

  it('is manager-only: the owner may not add one, though their Payment proof still works', async () => {
    const { token: buyer } = await loginAs(MARCUS);
    const id = await createOrder(buyer, { advance: false });

    const denied = await multipart(`/api/orders/${id}/status-meta/Commission/attachments`,
      { file: PNG() }, { token: buyer });
    expect(denied.status).toBe(403);
    const ok = await multipart(`/api/orders/${id}/status-meta/Payment/attachments`,
      { file: PNG() }, { token: buyer });
    expect(ok.status).toBe(200);
  });
});
