import { beforeEach, describe, it, expect } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('vendor general (customer-less) links', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('mints a customer-less link and rotates the prior one', async () => {
    const { token: mgr } = await loginAs(ALEX);

    const first = await api<{ id: string; token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    expect(first.status).toBe(201);
    expect(first.body.token).toBeTruthy();

    const sql = getTestDb();
    const row1 = (await sql`
      SELECT customer_id, active FROM vendor_links WHERE id = ${first.body.id}
    `)[0];
    expect(row1.customer_id).toBeNull();
    expect(row1.active).toBe(true);

    // Regenerate → prior general link deactivated, exactly one active.
    const second = await api<{ id: string; token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    expect(second.status).toBe(201);

    const activeGeneral = await sql`
      SELECT id FROM vendor_links WHERE customer_id IS NULL AND active = TRUE
    `;
    expect(activeGeneral.length).toBe(1);
    expect(activeGeneral[0].id).toBe(second.body.id);
  });

  it('returns the general link under `general`, absent from per-customer items', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await api<{ id: string }>('POST', '/api/customers', {
      token: mgr, body: { name: 'Per-Cust Co' },
    });
    await api('POST', `/api/customers/${cust.body.id}/vendor-link`, { token: mgr });
    const gen = await api<{ id: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });

    const list = await api<{
      items: { customerId: string; link: { id: string } | null }[];
      general: { id: string; token: string; bidCount: number } | null;
    }>('GET', '/api/customers/vendor-links', { token: mgr });

    expect(list.body.general).not.toBeNull();
    expect(list.body.general!.id).toBe(gen.body.id);
    expect(list.body.general!.bidCount).toBe(0);
    // The general link must not appear as a per-customer row.
    expect(list.body.items.some(i => i.link?.id === gen.body.id)).toBe(false);
  });

  it('portal /me is generic and bids store a null customer for a general link', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const gen = await api<{ token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    const t = gen.body.token;

    const me = await api<{ customer: { name: string } | null; label: string | null }>(
      'GET', `/api/public/vendor/${t}/me`);
    expect(me.status).toBe(200);
    expect(me.body.customer).toBeNull();

    const inv = await api<{ items: { id: string; qty: number }[] }>(
      'GET', '/api/inventory?status=Done', { token: mgr });
    const line = inv.body.items.find(i => i.qty >= 1)!;

    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${t}/bids`, {
        body: { contactName: 'Anon Vendor', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
      });
    expect(submit.status).toBe(201);

    const sql = getTestDb();
    const bid = (await sql`
      SELECT customer_id FROM vendor_bids WHERE id = ${submit.body.bidId}
    `)[0];
    expect(bid.customer_id).toBeNull();
  });

  it('bid list and detail return null customer for a general-link bid', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const gen = await api<{ token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    const inv = await api<{ items: { id: string; qty: number }[] }>(
      'GET', '/api/inventory?status=Done', { token: mgr });
    const line = inv.body.items.find(i => i.qty >= 1)!;
    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${gen.body.token}/bids`, {
        body: { contactName: 'Anon', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
      });

    const list = await api<{ items: { id: string; customer_name: string | null }[] }>(
      'GET', '/api/vendor-bids', { token: mgr });
    const listed = list.body.items.find(b => b.id === submit.body.bidId)!;
    expect(listed.customer_name).toBeNull();

    const detail = await api<{ bid: { customer_id: string | null; customer_name: string | null } }>(
      'GET', `/api/vendor-bids/${submit.body.bidId}`, { token: mgr });
    expect(detail.body.bid.customer_id).toBeNull();
    expect(detail.body.bid.customer_name).toBeNull();
  });

  async function generalBidReadyToPromote(mgr: string): Promise<string> {
    const gen = await api<{ token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    const inv = await api<{ items: { id: string; qty: number }[] }>(
      'GET', '/api/inventory?status=Done', { token: mgr });
    const line = inv.body.items.find(i => i.qty >= 1)!;
    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${gen.body.token}/bids`, {
        body: { contactName: 'Anon', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
      });
    const detail = await api<{ bid: { lines: { id: string }[] } }>(
      'GET', `/api/vendor-bids/${submit.body.bidId}`, { token: mgr });
    await api('POST', `/api/vendor-bids/${submit.body.bidId}/decide`, {
      token: mgr,
      body: { lines: [{ lineId: detail.body.bid.lines[0].id, decision: 'accepted' }] },
    });
    return submit.body.bidId;
  }

  it('promote of an unattributed bid requires a customerId', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const bidId = await generalBidReadyToPromote(mgr);

    const noCust = await api('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(noCust.status).toBe(400);

    const badCust = await api('POST', `/api/vendor-bids/${bidId}/promote`, {
      token: mgr, body: { customerId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(badCust.status).toBe(400);
  });

  it('promote with a valid customerId creates the SO and back-fills the bid', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const bidId = await generalBidReadyToPromote(mgr);
    const cust = await api<{ id: string }>('POST', '/api/customers', {
      token: mgr, body: { name: 'Chosen At Promote' },
    });

    const ok = await api<{ sellOrderId: string }>(
      'POST', `/api/vendor-bids/${bidId}/promote`, {
        token: mgr, body: { customerId: cust.body.id },
      });
    expect(ok.status).toBe(201);

    const sql = getTestDb();
    const so = (await sql`
      SELECT customer_id FROM sell_orders WHERE id = ${ok.body.sellOrderId}
    `)[0];
    expect(so.customer_id).toBe(cust.body.id);
    const bid = (await sql`
      SELECT customer_id FROM vendor_bids WHERE id = ${bidId}
    `)[0];
    expect(bid.customer_id).toBe(cust.body.id);
  });
});
