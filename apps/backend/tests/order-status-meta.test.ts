import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// Optional evidence (note + attachments) a manager can leave when moving a
// PO to Done — mirror of the sell-order status-meta endpoints, scoped to the
// single 'Done' status. Evidence is optional: /advance carries no gate.

// Audit events are gated on lifecycle !== 'draft' (drafts must stay
// deletable), so most tests advance the fresh order one stage first.
async function createOrder(token: string, opts: { advance?: boolean } = {}): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber: 'PO-META-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
      }],
    },
  });
  expect(r.status).toBe(201);
  if (opts.advance !== false) {
    const adv = await api('POST', `/api/orders/${r.body.id}/advance`, { token });
    expect(adv.status).toBe(200);
  }
  return r.body.id;
}

type StatusMeta = Record<string, {
  note: string | null;
  attachments: { id: string; filename: string; mime: string; url: string }[];
}>;
async function getStatusMeta(token: string, id: string): Promise<StatusMeta> {
  const r = await api<{ order: { statusMeta: StatusMeta } }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order.statusMeta;
}

async function getEvents(token: string, id: string) {
  const r = await api<{ events: Array<{ kind: string; detail: Record<string, unknown> }> }>(
    'GET', `/api/orders/${id}/events`, { token });
  expect(r.status).toBe(200);
  return r.body.events;
}

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'proof.png', { type: 'image/png' });

describe('PO status-meta — note', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager can upsert a Done note; it comes back on GET and writes an audit event', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);

    const put = await api('PUT', `/api/orders/${id}/status-meta/Done`, {
      token: mgr, body: { note: 'QC passed, received by Sam' },
    });
    expect(put.status).toBe(200);

    const meta = await getStatusMeta(mgr, id);
    expect(meta.Done.note).toBe('QC passed, received by Sam');

    const events = await getEvents(mgr, id);
    const noteEvents = events.filter(e => e.kind === 'status_meta_changed' && e.detail.field === 'note');
    expect(noteEvents).toHaveLength(1);
    expect(noteEvents[0].detail.to).toBe('QC passed, received by Sam');

    // Re-PUTting the same note must not write a second event.
    const again = await api('PUT', `/api/orders/${id}/status-meta/Done`, {
      token: mgr, body: { note: 'QC passed, received by Sam' },
    });
    expect(again.status).toBe(200);
    const events2 = await getEvents(mgr, id);
    expect(events2.filter(e => e.kind === 'status_meta_changed' && e.detail.field === 'note')).toHaveLength(1);
  });

  it('rejects purchasers (403), unknown statuses (400) and missing orders (404)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: purchaser } = await loginAs(MARCUS);
    const id = await createOrder(purchaser);

    const asPurchaser = await api('PUT', `/api/orders/${id}/status-meta/Done`, {
      token: purchaser, body: { note: 'hi' },
    });
    expect(asPurchaser.status).toBe(403);

    const badStatus = await api('PUT', `/api/orders/${id}/status-meta/Reviewing`, {
      token: mgr, body: { note: 'hi' },
    });
    expect(badStatus.status).toBe(400);

    const missing = await api('PUT', '/api/orders/PO-00000/status-meta/Done', {
      token: mgr, body: { note: 'hi' },
    });
    expect(missing.status).toBe(404);
  });
});

describe('PO status-meta — attachments', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager can upload, list and delete a Done attachment, with audit events', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);

    const up = await multipart(`/api/orders/${id}/status-meta/Done/attachments`,
      { file: PNG() }, { token: mgr });
    expect(up.status).toBe(200);
    const att = (up.body as { attachment: { id: string; filename: string; url: string } }).attachment;
    expect(att.filename).toBe('proof.png');
    expect(att.url).toBeTruthy();

    const meta = await getStatusMeta(mgr, id);
    expect(meta.Done.attachments).toHaveLength(1);
    expect(meta.Done.attachments[0].id).toBe(att.id);

    const del = await api('DELETE', `/api/orders/${id}/status-meta/Done/attachments/${att.id}`, { token: mgr });
    expect(del.status).toBe(200);
    const metaAfter = await getStatusMeta(mgr, id);
    expect(metaAfter.Done?.attachments ?? []).toHaveLength(0);

    const delAgain = await api('DELETE', `/api/orders/${id}/status-meta/Done/attachments/${att.id}`, { token: mgr });
    expect(delAgain.status).toBe(404);

    const events = await getEvents(mgr, id);
    const fields = events.filter(e => e.kind === 'status_meta_changed').map(e => e.detail.field);
    expect(fields).toContain('attachment_added');
    expect(fields).toContain('attachment_removed');
  });

  it('rejects disallowed MIME types (415) and purchasers (403)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: purchaser } = await loginAs(MARCUS);
    const id = await createOrder(purchaser);

    const html = new File(['<script>alert(1)</script>'], 'evil.html', { type: 'text/html' });
    const bad = await multipart(`/api/orders/${id}/status-meta/Done/attachments`,
      { file: html }, { token: mgr });
    expect(bad.status).toBe(415);

    const asPurchaser = await multipart(`/api/orders/${id}/status-meta/Done/attachments`,
      { file: PNG() }, { token: purchaser });
    expect(asPurchaser.status).toBe(403);
  });
});

describe('PO status-meta — drafts', () => {
  beforeEach(async () => { await resetDb(); });

  it('evidence on a draft writes no audit events and keeps the draft deletable', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: purchaser } = await loginAs(MARCUS);
    const id = await createOrder(purchaser, { advance: false });

    const put = await api('PUT', `/api/orders/${id}/status-meta/Done`, {
      token: mgr, body: { note: 'early note' },
    });
    expect(put.status).toBe(200);
    const up = await multipart(`/api/orders/${id}/status-meta/Done/attachments`,
      { file: PNG() }, { token: mgr });
    expect(up.status).toBe(200);

    const events = await getEvents(mgr, id);
    expect(events.filter(e => e.kind === 'status_meta_changed')).toHaveLength(0);

    // The order_events append-only trigger fires even on CASCADE — a draft
    // with audit rows would make this DELETE blow up.
    const del = await api('DELETE', `/api/orders/${id}`, { token: purchaser });
    expect(del.status).toBe(200);
  });
});

describe('PO advance to done — evidence stays optional', () => {
  beforeEach(async () => { await resetDb(); });

  it('a manager can jump to done with no note or attachments', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(mgr);

    const adv = await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'done' },
    });
    expect(adv.status).toBe(200);

    const r = await api<{ order: { lifecycle: string; statusMeta: StatusMeta } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(r.body.order.lifecycle).toBe('done');
    expect(r.body.order.statusMeta).toEqual({});
  });
});
