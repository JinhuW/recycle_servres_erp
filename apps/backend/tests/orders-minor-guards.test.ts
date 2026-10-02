import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chat.png', { type: 'image/png' });

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 2, unitCost: 60,
};

async function selfPaidInTransit(token: string): Promise<{ id: string; chatId: string }> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token, body: { category: 'RAM', warehouseId: 'WH-LA1', payment: 'self', lines: [LINE] },
  });
  expect(r.status).toBe(201);
  const up = await multipart(`/api/orders/${r.body.id}/status-meta/Submission/attachments`,
    { file: PNG() }, { token });
  expect(up.status).toBe(200);
  const chatId = (up.body as { attachment: { id: string } }).attachment.id;
  expect((await api('POST', `/api/orders/${r.body.id}/advance`, { token })).status).toBe(200);
  return { id: r.body.id, chatId };
}

describe('PO guards from the review', () => {
  beforeEach(async () => { await resetDb(); });

  // The chat screenshot is what let a self-paid order leave Draft; deleting
  // the only one would leave a submitted order that could never have been.
  it('keeps the last required chat screenshot on a submitted self-paid order', async () => {
    const { token } = await loginAs(MARCUS);
    const { id, chatId } = await selfPaidInTransit(token);

    const refused = await api<{ error: string }>('DELETE',
      `/api/orders/${id}/status-meta/Submission/attachments/${chatId}`, { token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/replacement/i);

    const second = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
      { file: PNG() }, { token });
    expect(second.status).toBe(200);
    const swapped = await api('DELETE',
      `/api/orders/${id}/status-meta/Submission/attachments/${chatId}`, { token });
    expect(swapped.status).toBe(200);
  });

  it('lets a manager remove the last chat screenshot anyway', async () => {
    const { token } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, chatId } = await selfPaidInTransit(token);
    const r = await api('DELETE',
      `/api/orders/${id}/status-meta/Submission/attachments/${chatId}`, { token: mgr });
    expect(r.status).toBe(200);
  });

  it('refuses a manager stage-jump to the stage the order is already at', async () => {
    const { token } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id } = await selfPaidInTransit(token);
    const before = await getTestDb()<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'order_submitted'
    `;
    const r = await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'in_transit' },
    });
    expect(r.status).toBe(409);
    const after = await getTestDb()<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'order_submitted'
    `;
    expect(after[0].n).toBe(before[0].n);
  });

  it('freezes `payment` with the rest of the closed book', async () => {
    const { token } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id } = await selfPaidInTransit(token);
    expect((await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'ready_to_pay' },
    })).status).toBe(200);

    const r = await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { payment: 'company' } });
    expect(r.status).not.toBe(200);
    const [row] = await getTestDb()<{ payment: string }[]>`SELECT payment FROM orders WHERE id = ${id}`;
    expect(row.payment).toBe('self');
  });

  it('answers 400, not 500, for line ids that are not uuids', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token, body: { category: 'RAM', warehouseId: 'WH-LA1', payment: 'self', lines: [LINE] },
    });
    const bad = await api('PATCH', `/api/orders/${r.body.id}`, {
      token, body: { removeLineIds: ['not-a-uuid'] },
    });
    expect(bad.status).toBe(400);
    const badLine = await api('PATCH', `/api/orders/${r.body.id}`, {
      token, body: { lines: [{ id: 'nope', qty: 3 }] },
    });
    expect(badLine.status).toBe(400);
  });
});
