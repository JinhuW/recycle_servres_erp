import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// H5 regression: the sell-order status-meta attachment upload only enforced
// the size cap (maxBytes) and never checked the MIME type. A manager could
// upload HTML/SVG into the PUBLIC R2 bucket -> stored XSS. scan.ts already
// rejects disallowed types with 415; this endpoint must do the same.

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

describe('POST /api/sell-orders/:id/status-meta/:status/attachments — MIME guard', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects a disallowed MIME type with 415 before any upload', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);

    const html = new File(['<script>alert(1)</script>'], 'evil.html', { type: 'text/html' });
    const r = await multipart(
      `/api/sell-orders/${id}/status-meta/Shipped/attachments`,
      { file: html },
      { token },
    );
    expect(r.status).toBe(415);
  });

  it('does not 415 an allowed MIME type', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);

    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', { type: 'application/pdf' });
    const r = await multipart(
      `/api/sell-orders/${id}/status-meta/Shipped/attachments`,
      { file: pdf },
      { token },
    );
    expect(r.status).not.toBe(415);
  });
});
