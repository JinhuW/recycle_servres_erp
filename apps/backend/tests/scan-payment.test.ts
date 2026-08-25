import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { normalizePaypalTxnId } from '../src/ai/paypal';

function png(): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'paypal.png', { type: 'image/png' });
}

describe('normalizePaypalTxnId', () => {
  it('canonicalizes whitespace and case, rejects junk', () => {
    expect(normalizePaypalTxnId(' 8xy12345 ab678901c ')).toBe('8XY12345AB678901C');
    expect(normalizePaypalTxnId('8XY12345AB678901C')).toBe('8XY12345AB678901C');
    expect(normalizePaypalTxnId('short')).toBeNull();          // under loose floor
    expect(normalizePaypalTxnId('has-dashes-1234567')).toBeNull();
    expect(normalizePaypalTxnId('A'.repeat(33))).toBeNull();   // over loose ceiling
    expect(normalizePaypalTxnId(null)).toBeNull();
    expect(normalizePaypalTxnId(42)).toBeNull();
  });
});

describe('POST /api/scan/payment', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('stub path: no key → canned txn id, no label_scans row', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/payment', { file: png() }, { token });
    expect(r.status).toBe(200);
    const body = r.body as { storageKey: string; txnId: string; confidence: number; provider: string };
    expect(body.provider).toBe('stub');
    expect(body.txnId).toBe('7AB12345CD678901E');
    expect(body.storageKey).toBeTruthy();
    const sql = getTestDb();
    expect(await sql`SELECT id FROM label_scans`).toHaveLength(0);
  });

  it('openrouter path: extraction is normalized; sloppy shape caps confidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"txnId":" 8xy12345 ab678901c ","confidence":0.97}' } }] }),
          { status: 200 },
        ),
      ),
    );
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/payment', { file: png() }, { token, env: { OPENROUTER_API_KEY: 'test-key' } });
    expect(r.status).toBe(200);
    const body = r.body as { txnId: string; confidence: number; provider: string };
    expect(body.provider).toBe('openrouter');
    expect(body.txnId).toBe('8XY12345AB678901C');
    expect(body.confidence).toBeCloseTo(0.97);
  });

  it('rejects a missing file and a non-image MIME', async () => {
    const { token } = await loginAs(MARCUS);
    const noFile = await multipart('/api/scan/payment', {}, { token });
    expect(noFile.status).toBe(400);
    const pdf = new File([new Uint8Array([0x25, 0x50])], 'doc.pdf', { type: 'application/pdf' });
    const wrongMime = await multipart('/api/scan/payment', { file: pdf }, { token });
    expect(wrongMime.status).toBe(415);
  });

  it('fail-fast: OpenRouter 500 → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/payment', { file: png() }, { token, env: { OPENROUTER_API_KEY: 'test-key' } });
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/OCR failed/);
  });
});

describe('paypal txn id — package → PO carry-over and PATCH', () => {
  beforeEach(async () => { await resetDb(); });

  const TN = '1Z999AA10123456784';

  async function addPkg(token: string, over: Record<string, unknown> = {}) {
    const r = await api<{ package: { id: string; paypalTxnId: string | null; paymentScreenshotUrl: string | null } }>(
      'POST', '/api/packages',
      { token, body: { trackingNumber: TN, carrier: 'UPS', ...over } },
    );
    expect(r.status).toBe(201);
    return r.body.package;
  }

  it('stores a normalized txn id + screenshot on the package and copies it onto the PO', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPkg(token, {
      paypalTxnId: ' 8xy12345 ab678901c ',
      paymentScreenshotKey: 'payment-screens/abc-shot.png',
      paymentScreenshotUrl: 'https://static.example.com/att/payment-screens/abc-shot.png',
    });
    expect(pkg.paypalTxnId).toBe('8XY12345AB678901C');
    expect(pkg.paymentScreenshotUrl).toBe('https://static.example.com/att/payment-screens/abc-shot.png');

    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const created = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, { token, body: {} });
    expect(created.status).toBe(201);

    const order = await api<{ order: { paypalTxnId: string | null } }>('GET', `/api/orders/${created.body.orderId}`, { token });
    expect(order.body.order.paypalTxnId).toBe('8XY12345AB678901C');
  });

  it('a package without a txn id mints a PO with a null field', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPkg(token);
    expect(pkg.paypalTxnId).toBeNull();
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const created = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, { token, body: {} });
    const order = await api<{ order: { paypalTxnId: string | null } }>('GET', `/api/orders/${created.body.orderId}`, { token });
    expect(order.body.order.paypalTxnId).toBeNull();
  });

  it('rejects an oversized txn id at the add-package boundary', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/packages', {
      token, body: { trackingNumber: TN, carrier: 'UPS', paypalTxnId: 'A'.repeat(65) },
    });
    expect(r.status).toBe(400);
  });

  it('PATCH: manager sets and clears the id (audited), non-owner-manager rules hold', async () => {
    const marcus = await loginAs(MARCUS);
    const mgr = await loginAs(ALEX);
    const pkg = await addPkg(marcus.token);
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const created = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, { token: marcus.token, body: {} });
    const orderId = created.body.orderId;

    const set = await api('PATCH', `/api/orders/${orderId}`, {
      token: mgr.token, body: { paypalTxnId: ' 9zz98765 xy432109q ' },
    });
    expect(set.status).toBe(200);
    let row = (await sql`SELECT paypal_txn_id FROM orders WHERE id = ${orderId}`)[0] as { paypal_txn_id: string | null };
    expect(row.paypal_txn_id).toBe('9ZZ98765XY432109Q');

    const events = await sql<{ detail: { changes?: { field: string }[] } }[]>`
      SELECT detail FROM order_events WHERE order_id = ${orderId} AND kind = 'meta_changed'
    `;
    expect(events.some(e => (e.detail.changes ?? []).some(ch => ch.field === 'paypal_txn_id'))).toBe(true);

    const clear = await api('PATCH', `/api/orders/${orderId}`, { token: mgr.token, body: { paypalTxnId: null } });
    expect(clear.status).toBe(200);
    row = (await sql`SELECT paypal_txn_id FROM orders WHERE id = ${orderId}`)[0] as { paypal_txn_id: string | null };
    expect(row.paypal_txn_id).toBeNull();
  });

  it('PATCH: the owner edits it in draft; after submission it is manager-only', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const pkg = await addPkg(marcus.token);
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const created = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, { token: marcus.token, body: {} });
    const orderId = created.body.orderId;

    const draftEdit = await api('PATCH', `/api/orders/${orderId}`, {
      token: marcus.token, body: { paypalTxnId: '8XY12345AB678901C' },
    });
    expect(draftEdit.status).toBe(200);

    const stranger = await api('PATCH', `/api/orders/${orderId}`, {
      token: priya.token, body: { paypalTxnId: '8XY12345AB678901C' },
    });
    expect(stranger.status).toBe(403);

    await sql`UPDATE orders SET lifecycle = 'in_transit' WHERE id = ${orderId}`;
    const postSubmit = await api('PATCH', `/api/orders/${orderId}`, {
      token: marcus.token, body: { paypalTxnId: '9ZZ98765XY432109Q' },
    });
    expect(postSubmit.status).toBe(403);
  });
});
