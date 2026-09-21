import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// The commission payment is a screenshot in the 'Commission' status-meta
// bucket — nothing more. Manager-only to write, readable by the owner, and
// gating nothing: the Done dialog asks for it when it is missing, but
// /advance does not refuse without it.

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200',
  partNumber: 'PO-COMM-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
};

async function createOrder(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', lines: [LINE] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

type StatusMeta = Record<string, { attachments: { id: string; filename: string }[] }>;
async function getStatusMeta(token: string, id: string): Promise<StatusMeta> {
  const r = await api<{ order: { statusMeta: StatusMeta } }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order.statusMeta;
}

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'paid.png', { type: 'image/png' });

describe('Commission screenshots', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager uploads one; it is listed under the Commission bucket and the response is a plain attachment', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);

    const up = await multipart(`/api/orders/${id}/status-meta/Commission/attachments`,
      { file: PNG() }, { token: mgr });
    expect(up.status).toBe(200);
    const body = up.body as { attachment: { id: string; filename: string } };
    // The receipt rename has no stub: without an OCR key the original name
    // stays, as the Payment-bucket tests rely on too.
    expect(body.attachment.filename).toBe('paid.png');
    expect('scan' in (up.body as object)).toBe(false);

    const meta = await getStatusMeta(mgr, id);
    expect(meta.Commission.attachments.map(a => a.id)).toEqual([body.attachment.id]);

    const del = await api('DELETE', `/api/orders/${id}/status-meta/Commission/attachments/${body.attachment.id}`, { token: mgr });
    expect(del.status).toBe(200);
    expect((await getStatusMeta(mgr, id)).Commission?.attachments ?? []).toHaveLength(0);
  });

  it('is manager-only: the owner may not add one, though their Payment proof still works', async () => {
    const { token: buyer } = await loginAs(MARCUS);
    const id = await createOrder(buyer);

    const denied = await multipart(`/api/orders/${id}/status-meta/Commission/attachments`,
      { file: PNG() }, { token: buyer });
    expect(denied.status).toBe(403);
    const ok = await multipart(`/api/orders/${id}/status-meta/Payment/attachments`,
      { file: PNG() }, { token: buyer });
    expect(ok.status).toBe(200);
  });
});
