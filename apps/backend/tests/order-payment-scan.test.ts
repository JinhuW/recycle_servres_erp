import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// POST /api/orders/:id/status-meta/Payment/attachments?scan=paypal — the
// cost-payment screenshot is stored as a Payment attachment and the PayPal
// transaction id read off it in the same upload. The file is the record; the
// read is a convenience that may fail without losing it.

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 2, unitCost: 60,
};

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'paypal.png', { type: 'image/png' });

async function createOrder(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', warehouseId: 'WH-LA1', payment: 'company', paymentMethod: 'paypal', lines: [LINE] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

type Upload = {
  attachment: { id: string; filename: string; url: string };
  scan?: { txnId: string | null; confidence: number; provider: string } | null;
};

describe('Payment attachment with ?scan=paypal', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('stores the file and returns the transaction id read off it', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token);
    const r = await multipart(`/api/orders/${id}/status-meta/Payment/attachments?scan=paypal`,
      { file: PNG() }, { token });
    expect(r.status).toBe(200);
    const body = r.body as Upload;
    expect(body.attachment.id).toBeTruthy();
    expect(body.scan?.provider).toBe('stub');
    expect(body.scan?.txnId).toBe('7AB12345CD678901E');
    const rows = await getTestDb()`
      SELECT id FROM order_status_attachments WHERE order_id = ${id} AND status = 'Payment'`;
    expect(rows).toHaveLength(1);
  });

  it('keeps the file and answers scan: null when the OCR fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('openrouter down'); }));
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token);
    const r = await multipart(`/api/orders/${id}/status-meta/Payment/attachments?scan=paypal`,
      { file: PNG() }, { token, env: { OPENROUTER_API_KEY: 'test-key' } });
    expect(r.status).toBe(200);
    const body = r.body as Upload;
    expect(body.attachment.id).toBeTruthy();
    expect(body.scan).toBeNull();
    const rows = await getTestDb()`
      SELECT id FROM order_status_attachments WHERE order_id = ${id} AND status = 'Payment'`;
    expect(rows).toHaveLength(1);
  });

  it('is opt-in, and only on the Payment bucket', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token);
    const plain = await multipart(`/api/orders/${id}/status-meta/Payment/attachments`,
      { file: PNG() }, { token });
    expect(plain.status).toBe(200);
    expect('scan' in (plain.body as Upload)).toBe(false);
    const chat = await multipart(`/api/orders/${id}/status-meta/Submission/attachments?scan=paypal`,
      { file: PNG() }, { token });
    expect(chat.status).toBe(200);
    expect('scan' in (chat.body as Upload)).toBe(false);
  });
});
