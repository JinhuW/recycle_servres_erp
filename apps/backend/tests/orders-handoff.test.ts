import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import { stubPaypalProvider } from '../src/banktx/stub';

// POST /api/orders/:id/handoff — the Draft → In Transit hand-off as one
// transaction: the dialog's fields, the package a tracking number becomes, and
// the advance itself, all or nothing.

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 2, unitCost: 60,
};

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chat.png', { type: 'image/png' });

async function createOrder(token: string, payment: 'company' | 'self'): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', warehouseId: 'WH-LA1', payment, lines: [LINE] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function attachChat(token: string, id: string): Promise<void> {
  const up = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
    { file: PNG() }, { token });
  expect(up.status).toBe(200);
}

async function attachPaymentShot(token: string, id: string): Promise<void> {
  const up = await multipart(`/api/orders/${id}/status-meta/Payment/attachments`,
    { file: PNG() }, { token });
  expect(up.status).toBe(200);
}

type OrderRead = {
  order: {
    lifecycle: string; source: string | null; paymentMethod: string | null;
    handoffMethod: string | null; handoffBy: { id: string; name: string } | null;
    payment: string; paypalTxnId: string | null; warehouse: { id: string } | null;
    commissionRate: number | null;
  };
};
async function readOrder(token: string, id: string) {
  const got = await api<OrderRead>('GET', `/api/orders/${id}`, { token });
  expect(got.status).toBe(200);
  return got.body.order;
}

type ListRow = {
  id: string; handoffMethod: string | null;
  tracking: { carrier: string; trackingNumber: string; trackingUrl: string | null } | null;
};
/** The same PO as the list reports it — the In Transit chip reads these. */
async function listRow(token: string, id: string): Promise<ListRow> {
  const got = await api<{ orders: ListRow[] }>('GET', '/api/orders', { token });
  expect(got.status).toBe(200);
  const row = got.body.orders.find(r => r.id === id);
  expect(row).toBeDefined();
  return row!;
}

async function events(id: string): Promise<{ kind: string; detail: Record<string, unknown> }[]> {
  const sql = getTestDb();
  return (await sql`
    SELECT kind, detail FROM order_events WHERE order_id = ${id} ORDER BY created_at, id
  `) as unknown as { kind: string; detail: Record<string, unknown> }[];
}

const pickup = (byUserId: string) => ({ method: 'pickup', byUserId });
const label = { method: 'label', trackingNumber: '1Z 999 AA1 01 2345 6784', carrier: 'UPS' };

describe('hand-off — local pickup', () => {
  beforeEach(async () => { await resetDb(); });

  it('self-paid: refuses without the chat screenshot, then records pickup and advances', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    const body = { warehouseId: 'WH-LA1', source: 'facebook', handoff: pickup(user.id), payment: 'self' };

    const refused = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, { token, body });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/chat history/i);
    // All or nothing: the refused hand-off wrote none of its fields.
    const still = await readOrder(token, id);
    expect(still.lifecycle).toBe('draft');
    expect(still.source).toBeNull();
    expect(still.handoffMethod).toBeNull();

    await attachChat(token, id);
    const ok = await api<{ ok: true; lifecycle: string; packageId: string | null }>(
      'POST', `/api/orders/${id}/handoff`, { token, body });
    expect(ok.status).toBe(200);
    expect(ok.body.lifecycle).toBe('in_transit');
    expect(ok.body.packageId).toBeNull();

    const o = await readOrder(token, id);
    expect(o.lifecycle).toBe('in_transit');
    expect(o.source).toBe('facebook');
    expect(o.handoffMethod).toBe('pickup');
    expect(o.handoffBy?.id).toBe(user.id);
    expect(o.paymentMethod).toBeNull();
    // Nothing to track: the list says "Local" from the method alone.
    expect(await listRow(token, id)).toMatchObject({ handoffMethod: 'pickup', tracking: null });
  });

  it('logs every field it changed and the hand-off itself', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    const r = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { warehouseId: 'WH-LA1', source: 'reddit', handoff: pickup(user.id), payment: 'self' },
    });
    expect(r.status).toBe(200);

    const evs = await events(id);
    const meta = evs.find(e => e.kind === 'meta_changed');
    expect(meta).toBeTruthy();
    const fields = (meta!.detail.changes as { field: string; from: unknown; to: unknown }[]).map(c => c.field);
    expect(fields).toEqual(expect.arrayContaining(['source', 'handoff_method', 'handoff_by']));
    const handoff = evs.find(e => e.kind === 'handoff');
    expect(handoff?.detail).toMatchObject({ method: 'pickup', byUserId: user.id });
    expect(evs.map(e => e.kind)).toContain('submitted');
  });

  it('company card + PayPal needs the transaction ID; cash needs the amount screenshot', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    const base = { warehouseId: 'WH-LA1', source: 'local', handoff: pickup(user.id), payment: 'company' };

    const noId = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...base, paymentMethod: 'paypal' },
    });
    expect(noId.status).toBe(409);
    expect(noId.body.error).toMatch(/transaction ID/i);
    expect((await readOrder(token, id)).lifecycle).toBe('draft');

    const noShot = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...base, paymentMethod: 'cash' },
    });
    expect(noShot.status).toBe(409);
    expect(noShot.body.error).toMatch(/paid in cash/i);
    // The refusal rolled the method back with everything else.
    expect((await readOrder(token, id)).paymentMethod).toBeNull();

    await attachPaymentShot(token, id);
    const cash = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...base, paymentMethod: 'cash' },
    });
    expect(cash.status).toBe(200);
    const o = await readOrder(token, id);
    expect(o.lifecycle).toBe('in_transit');
    expect(o.paymentMethod).toBe('cash');
    expect(o.paypalTxnId).toBeNull();
  });

  it('company card + PayPal advances with the ID and keeps it', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    const r = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: {
        warehouseId: 'WH-LA1', source: 'other', handoff: pickup(user.id),
        payment: 'company', paymentMethod: 'paypal', paypalTxnId: '7ab12345cd 678901e',
      },
    });
    expect(r.status).toBe(200);
    const o = await readOrder(token, id);
    expect(o.paypalTxnId).toBe('7AB12345CD678901E');
    expect(o.paymentMethod).toBe('paypal');
  });

  it('company card + PayPal refuses an ID our PayPal account never made, leaving nothing behind', async () => {
    // Once a PayPal account has synced, the id is checked against its rows —
    // the advance inside the hand-off holds to it, so the package the label
    // would have created is rolled back with everything else.
    await syncBankTransactions(testEnv, [stubPaypalProvider()]);
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    const r = await api<{ error: string; paypalTxnId: string }>('POST', `/api/orders/${id}/handoff`, {
      token, body: {
        warehouseId: 'WH-LA1', source: 'other', handoff: label,
        payment: 'company', paymentMethod: 'paypal', paypalTxnId: 'NOSUCHTXN00000001',
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/PayPal account/i);
    expect(r.body.paypalTxnId).toBe('NOSUCHTXN00000001');
    const o = await readOrder(token, id);
    expect(o.lifecycle).toBe('draft');
    expect(o.paypalTxnId).toBeNull();
    const sql = getTestDb();
    expect((await sql`SELECT 1 FROM packages WHERE order_id = ${id}`).length).toBe(0);
  });
});

describe('hand-off — shipping label', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates the package linked to the PO, carrying its source, and advances', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    await attachPaymentShot(token, id);
    const r = await api<{ packageId: string | null }>('POST', `/api/orders/${id}/handoff`, {
      token, body: {
        warehouseId: 'WH-LA1', source: 'facebook', handoff: label,
        payment: 'company', paymentMethod: 'cash',
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.packageId).toBeTruthy();

    const sql = getTestDb();
    const pkg = (await sql`
      SELECT tracking_number, carrier, source, order_id, status FROM packages WHERE id = ${r.body.packageId!}
    `)[0] as { tracking_number: string; carrier: string; source: string; order_id: string; status: string };
    expect(pkg).toMatchObject({
      tracking_number: '1Z999AA10123456784', carrier: 'UPS', source: 'facebook', order_id: id, status: 'purchased',
    });
    const o = await readOrder(token, id);
    expect(o.lifecycle).toBe('in_transit');
    expect(o.handoffMethod).toBe('label');
    const handoff = (await events(id)).find(e => e.kind === 'handoff');
    expect(handoff?.detail).toMatchObject({ method: 'label', trackingNumber: '1Z999AA10123456784', carrier: 'UPS' });
    // The list carries the box with its carrier deep link, so the In Transit
    // chip can name UPS and go straight to the tracking page.
    expect(await listRow(token, id)).toMatchObject({
      handoffMethod: 'label',
      tracking: {
        carrier: 'UPS', trackingNumber: '1Z999AA10123456784',
        trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      },
    });
  });

  it('a tracking number already on file refuses and leaves the PO in Draft', async () => {
    const { token } = await loginAs(MARCUS);
    const first = await createOrder(token, 'company');
    await attachPaymentShot(token, first);
    const body = {
      warehouseId: 'WH-LA1', source: 'facebook', handoff: label, payment: 'company', paymentMethod: 'cash',
    };
    expect((await api('POST', `/api/orders/${first}/handoff`, { token, body })).status).toBe(200);

    const second = await createOrder(token, 'company');
    await attachPaymentShot(token, second);
    const r = await api<{ error: string }>('POST', `/api/orders/${second}/handoff`, { token, body });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already being tracked/i);
    const o = await readOrder(token, second);
    expect(o.lifecycle).toBe('draft');
    expect(o.handoffMethod).toBeNull();
  });

  it('rejects a malformed tracking number or carrier', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    const base = { warehouseId: 'WH-LA1', source: 'facebook', payment: 'company', paymentMethod: 'cash' };
    const bad = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...base, handoff: { method: 'label', trackingNumber: 'abc!!', carrier: 'UPS' } },
    });
    expect(bad.status).toBe(400);
    const badCarrier = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...base, handoff: { ...label, carrier: 'DHL' } },
    });
    expect(badCarrier.status).toBe(400);
  });
});

describe('hand-off — validation and permissions', () => {
  beforeEach(async () => { await resetDb(); });

  it('400s on a bad source, a missing warehouse, or a self-paid method', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    const good = { warehouseId: 'WH-LA1', source: 'facebook', handoff: pickup(user.id), payment: 'self' };

    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, source: 'ebay' } })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, warehouseId: '' } })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, warehouseId: 'WH-NOPE' } })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...good, payment: 'company' },
    })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...good, handoff: { method: 'pickup', byUserId: 'not-a-uuid' } },
    })).status).toBe(400);
    expect((await readOrder(token, id)).lifecycle).toBe('draft');
  });

  it('a purchaser cannot set the commission rate or reassign the owner', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    const good = { warehouseId: 'WH-LA1', source: 'facebook', handoff: pickup(user.id), payment: 'self' };
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, commissionRate: 0.2 } })).status).toBe(403);
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, onBehalfOfUserId: user.id } })).status).toBe(403);
  });

  it('a manager can hand off a purchaser\'s PO, set the rate and pick who collected it', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const id = await createOrder(pTok, 'self');
    await attachChat(pTok, id);
    const { token: mTok, user: alex } = await loginAs(ALEX);
    const r = await api('POST', `/api/orders/${id}/handoff`, {
      token: mTok, body: {
        warehouseId: 'WH-LA1', source: 'local', handoff: pickup(alex.id), payment: 'self', commissionRate: 0.12,
      },
    });
    expect(r.status).toBe(200);
    const o = await readOrder(mTok, id);
    expect(o.lifecycle).toBe('in_transit');
    expect(o.handoffBy?.id).toBe(alex.id);
    expect(o.commissionRate).toBeCloseTo(0.12);
  });

  it('refuses a PO that already left Draft', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    const body = { warehouseId: 'WH-LA1', source: 'facebook', handoff: pickup(user.id), payment: 'self' };
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body })).status).toBe(200);
    const again = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, { token, body });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already In Transit/);
  });

  it('every role can read the member names; the full list stays manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    const names = await api<{ items: { id: string; name: string }[] }>('GET', '/api/members/names', { token });
    expect(names.status).toBe(200);
    expect(names.body.items.length).toBeGreaterThan(1);
    expect(Object.keys(names.body.items[0]).sort()).toEqual(['id', 'name']);
    expect((await api('GET', '/api/members', { token })).status).toBe(403);
  });
});
