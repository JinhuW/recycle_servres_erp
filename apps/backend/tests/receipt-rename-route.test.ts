import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// Receipt auto-rename: uploads to payment-receipt statuses go through the
// OCR renamer (date-method-amount.ext); everything else — and every OCR
// failure mode — keeps the browser-original filename. The model call is a
// stubbed global fetch; app.fetch and the R2 stub never touch global fetch,
// so a strict stub is safe.

const KEY = { OPENROUTER_API_KEY: 'test-key' };
const TODAY = new Date().toISOString().slice(0, 10);

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'IMG_2041.png', { type: 'image/png' });
const PDF = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'confirmation.pdf', { type: 'application/pdf' });

function mockModel(content: string) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function createDraftSellOrder(token: string): Promise<string> {
  const line = await freeSellableLine(token);
  const cust = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId: cust.body.items[0].id,
      lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: 1, unitPrice: line.sell_price }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function createPurchaseOrder(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber: 'RCPT-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

function uploadedName(r: { body: unknown }): string {
  return (r.body as { attachment: { filename: string } }).attachment.filename;
}

describe('receipt auto-rename — sell orders', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('renames Awaiting payment and Done uploads from the model extraction', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    mockModel('{"method":"alipay","amount":"1250.00"}');

    for (const status of ['Awaiting payment', 'Done']) {
      const r = await multipart(
        `/api/sell-orders/${id}/status-meta/${encodeURIComponent(status)}/attachments`,
        { file: PNG() }, { token, env: KEY },
      );
      expect(r.status).toBe(200);
      expect(uploadedName(r)).toBe(`${TODAY}-alipay-1250.00.png`);
    }
  });

  it('Shipped keeps the original name even with a key present', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const fn = mockModel('{"method":"alipay","amount":"1250.00"}');

    const r = await multipart(
      `/api/sell-orders/${id}/status-meta/Shipped/attachments`,
      { file: PNG() }, { token, env: KEY },
    );
    expect(r.status).toBe(200);
    expect(uploadedName(r)).toBe('IMG_2041.png');
    expect(fn).not.toHaveBeenCalled();
  });

  it('no API key → original name, no model call', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const fn = mockModel('{"method":"alipay","amount":"1250.00"}');

    const r = await multipart(
      `/api/sell-orders/${id}/status-meta/${encodeURIComponent('Awaiting payment')}/attachments`,
      { file: PNG() }, { token },
    );
    expect(r.status).toBe(200);
    expect(uploadedName(r)).toBe('IMG_2041.png');
    expect(fn).not.toHaveBeenCalled();
  });

  it('PDF keeps the original name, no model call', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const fn = mockModel('{"method":"alipay","amount":"1250.00"}');

    const r = await multipart(
      `/api/sell-orders/${id}/status-meta/Done/attachments`,
      { file: PDF() }, { token, env: KEY },
    );
    expect(r.status).toBe(200);
    expect(uploadedName(r)).toBe('confirmation.pdf');
    expect(fn).not.toHaveBeenCalled();
  });

  it('unreadable receipt (model nulls) keeps the original name', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    mockModel('{"method":null,"amount":null}');

    const r = await multipart(
      `/api/sell-orders/${id}/status-meta/Done/attachments`,
      { file: PNG() }, { token, env: KEY },
    );
    expect(r.status).toBe(200);
    expect(uploadedName(r)).toBe('IMG_2041.png');
  });
});

describe('receipt auto-rename — purchase orders', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('renames Submission and Done uploads; DB row carries the new name', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createPurchaseOrder(token);
    mockModel('{"method":"zelle","amount":"¥1,980"}');

    for (const status of ['Submission', 'Done']) {
      const r = await multipart(
        `/api/orders/${id}/status-meta/${status}/attachments`,
        { file: PNG() }, { token, env: KEY },
      );
      expect(r.status).toBe(200);
      expect(uploadedName(r)).toBe(`${TODAY}-zelle-1980.00.png`);
    }

    const sql = getTestDb();
    const rows = await sql`
      SELECT filename FROM order_status_attachments WHERE order_id = ${id}
    `;
    expect(rows.map((x: { filename: string }) => x.filename))
      .toEqual([`${TODAY}-zelle-1980.00.png`, `${TODAY}-zelle-1980.00.png`]);
  });

  it('no API key → original name', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createPurchaseOrder(token);
    const fn = mockModel('{"method":"zelle","amount":"1980.00"}');

    const r = await multipart(
      `/api/orders/${id}/status-meta/Done/attachments`,
      { file: PNG() }, { token },
    );
    expect(r.status).toBe(200);
    expect(uploadedName(r)).toBe('IMG_2041.png');
    expect(fn).not.toHaveBeenCalled();
  });
});
