import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { createSellOrderOn } from './helpers/fixtures';
import { freeSellableLine } from './helpers/inventory';
import { eventsOf } from './helpers/sellOrderEvents';

// Order-level attachments: the files that belong to the sell order as a
// whole, apart from the per-status evidence under status-meta.

type Att = { id: string; filename: string; size: number; mime: string; url: string; uploadedAt: string; uploadedBy: string | null };

async function draftOrder(token: string): Promise<string> {
  const line = await freeSellableLine(token);
  return createSellOrderOn(token, line.id, 'PN-ATT', 1, line.sell_price);
}

const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'sale-record.pdf', { type: 'application/pdf' });

describe('sell-order attachments', () => {
  beforeEach(async () => { await resetDb(); });

  it('uploads, lists on the detail, records history and removes', async () => {
    const { token } = await loginAs(ALEX);
    const id = await draftOrder(token);

    const up = await multipart(`/api/sell-orders/${id}/attachments`, { file: pdf() }, { token });
    expect(up.status).toBe(200);
    const att = (up.body as { attachment: Att }).attachment;
    expect(att).toMatchObject({ filename: 'sale-record.pdf', mime: 'application/pdf', size: 4 });
    expect(typeof att.uploadedBy).toBe('string');

    const detail = await api<{ order: { attachments: Att[] } }>('GET', `/api/sell-orders/${id}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.body.order.attachments.map(a => a.id)).toEqual([att.id]);

    const del = await api('DELETE', `/api/sell-orders/${id}/attachments/${att.id}`, { token });
    expect(del.status).toBe(200);
    const after = await api<{ order: { attachments: Att[] } }>('GET', `/api/sell-orders/${id}`, { token });
    expect(after.body.order.attachments).toEqual([]);

    const kinds = (await eventsOf(id)).map(e => e.kind);
    expect(kinds).toContain('attachment_added');
    expect(kinds).toContain('attachment_removed');

    const again = await api('DELETE', `/api/sell-orders/${id}/attachments/${att.id}`, { token });
    expect(again.status).toBe(404);
  });

  it('refuses a disallowed type and a non-manager', async () => {
    const { token } = await loginAs(ALEX);
    const id = await draftOrder(token);

    const html = new File(['<script>alert(1)</script>'], 'evil.html', { type: 'text/html' });
    const r = await multipart(`/api/sell-orders/${id}/attachments`, { file: html }, { token });
    expect(r.status).toBe(415);

    const { token: purchaser } = await loginAs(MARCUS);
    const forbidden = await multipart(`/api/sell-orders/${id}/attachments`, { file: pdf() }, { token: purchaser });
    expect(forbidden.status).toBe(403);

    const missing = await multipart(`/api/sell-orders/SO-99999/attachments`, { file: pdf() }, { token });
    expect(missing.status).toBe(404);

    const sql = getTestDb();
    const rows = await sql`SELECT count(*)::int AS n FROM sell_order_attachments WHERE sell_order_id = ${id}`;
    expect(rows[0].n).toBe(0);
  });
});
