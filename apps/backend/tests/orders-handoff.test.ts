import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
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
    blockers: string[];
    package: {
      id: string; carrier: string; trackingNumber: string; trackingUrl: string | null;
      status: string; trackingStatus: string | null; trackingEta: string | null;
      lastTrackedAt: string | null; source: string | null;
    } | null;
  };
};
async function readOrder(token: string, id: string) {
  const got = await api<OrderRead>('GET', `/api/orders/${id}`, { token });
  expect(got.status).toBe(200);
  return got.body.order;
}

type ListRow = {
  id: string; handoffMethod: string | null; goodsTotal: number;
  tracking: {
    carrier: string; trackingNumber: string; trackingUrl: string | null;
    status: string; trackingEta: string | null;
  } | null;
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
    expect(o.package).toBeNull();
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
        status: 'purchased', trackingEta: null,
      },
    });
    // Before any carrier scan the PO page has the box but no ETA or headline.
    expect(o.package).toMatchObject({
      id: r.body.packageId, carrier: 'UPS', trackingNumber: '1Z999AA10123456784',
      trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      status: 'purchased', trackingStatus: null, trackingEta: null, lastTrackedAt: null,
    });
  });

  it('the carrier\'s updates reach the list chip and the PO page', async () => {
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
    // What the Shippo webhook writes (shipping/track.ts applyPackageTracking).
    const sql = getTestDb();
    await sql`
      UPDATE packages
         SET status = 'in_transit', tracking_status = 'Out for delivery',
             tracking_eta = '2026-09-22T00:00:00Z', last_tracked_at = '2026-09-19T14:00:00Z'
       WHERE id = ${r.body.packageId!}
    `;
    const row = await listRow(token, id);
    expect(row.tracking).toMatchObject({ status: 'in_transit' });
    expect(row.tracking?.trackingEta).toMatch(/^2026-09-22T00:00:00/);
    const o = await readOrder(token, id);
    expect(o.package).toMatchObject({ status: 'in_transit', trackingStatus: 'Out for delivery' });
    expect(o.package?.trackingEta).toMatch(/^2026-09-22T00:00:00/);
    expect(o.package?.lastTrackedAt).toMatch(/^2026-09-19T14:00:00/);
  });

  it('the list\'s goods total follows the stored figure, else the lines as bought', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    // 2 × $60, mirrored into total_cost at creation.
    expect((await listRow(token, id)).goodsTotal).toBe(120);
    const sql = getTestDb();
    // A legacy row never written since the mirror existed: the line sum, on
    // what was bought — a partial sale parks the original in qty_purchased.
    await sql`UPDATE orders SET total_cost = NULL WHERE id = ${id}`;
    await sql`UPDATE order_lines SET qty = 1, qty_purchased = 2 WHERE order_id = ${id}`;
    expect((await listRow(token, id)).goodsTotal).toBe(120);
    // A negotiated lot price stands apart from the lines.
    await sql`UPDATE orders SET total_cost = 100 WHERE id = ${id}`;
    expect((await listRow(token, id)).goodsTotal).toBe(100);
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

  it('400s on a bad source, a missing warehouse, or a bad method; a company row with no method is a 409', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    const good = { warehouseId: 'WH-LA1', source: 'facebook', handoff: pickup(user.id), payment: 'self' };

    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, source: 'ebay' } })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, warehouseId: '' } })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { ...good, warehouseId: 'WH-NOPE' } })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...good, paymentMethod: 'venmo' },
    })).status).toBe(400);
    // Absent method is not a bad request — it is the merged row's blocker,
    // judged inside the transaction like every other missing fact.
    const noMethod = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { ...good, payment: 'company' },
    });
    expect(noMethod.status).toBe(409);
    expect((noMethod.body as { error: string }).error).toMatch(/PayPal or cash/);
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

// The hand-off facts are the page's to edit: PATCH writes them, GET lists
// what still stands between a Draft and In Transit, and the checkpoint fills
// in only what the page did not.
describe('hand-off facts on the page', () => {
  beforeEach(async () => { await resetDb(); });

  const patch = (token: string, id: string, body: Record<string, unknown>) =>
    api<{ error?: string; lifecycle: string }>('PATCH', `/api/orders/${id}`, { token, body });

  it('GET lists every blocker in display order, and only for a live Draft', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    expect((await readOrder(token, id)).blockers)
      .toEqual(['missingSource', 'missingDelivery', 'missingMethod', 'missingTxnId']);

    expect((await patch(token, id, { source: 'facebook', handoffMethod: 'pickup', paymentMethod: 'cash' })).status).toBe(200);
    expect((await readOrder(token, id)).blockers).toEqual(['missingDelivery', 'missingCashShot']);

    const { user } = await loginAs(MARCUS);
    expect((await patch(token, id, { handoffBy: user.id })).status).toBe(200);
    await attachPaymentShot(token, id);
    const ready = await readOrder(token, id);
    expect(ready.blockers).toEqual([]);
    expect(ready.handoffBy?.id).toBe(user.id);

    // A filled-in page hands off with an empty body: the row is the answer.
    const r = await api('POST', `/api/orders/${id}/handoff`, { token, body: {} });
    expect(r.status).toBe(200);
    const after = await readOrder(token, id);
    expect(after.lifecycle).toBe('in_transit');
    expect(after.blockers).toEqual([]);
    const ho = (await events(id)).find(e => e.kind === 'handoff');
    expect(ho?.detail).toMatchObject({ method: 'pickup', byUserId: user.id, byName: user.name });
  });

  it('a $0 Draft lists noCost first; /advance refuses on it but not on a missing source', async () => {
    const { token: mTok } = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    const free = await api<{ id: string }>('POST', '/api/orders', {
      token, body: { category: 'RAM', warehouseId: 'WH-LA1', payment: 'self', lines: [{ ...LINE, unitCost: 0 }] },
    });
    expect(free.status).toBe(201);
    expect((await readOrder(token, free.body.id)).blockers[0]).toBe('noCost');
    const refused = await api<{ error: string }>('POST', `/api/orders/${free.body.id}/advance`, { token: mTok, body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/no cost/i);

    // Priced, self-paid, chat attached — but no source and no delivery. The
    // facts are the hand-off's; a manager stage-jump is not held to them.
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    expect((await readOrder(token, id)).blockers).toEqual(['missingSource', 'missingDelivery']);
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: {} })).status).toBe(409);
    expect((await api('POST', `/api/orders/${id}/advance`, { token: mTok, body: {} })).status).toBe(200);
    expect((await readOrder(token, id)).lifecycle).toBe('in_transit');
  });

  it('PATCH validates the facts, NULLs the collector on a label, and audits names', async () => {
    const { token, user } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    expect((await patch(token, id, { source: 'ebay' })).status).toBe(400);
    expect((await patch(token, id, { handoffMethod: 'drone' })).status).toBe(400);
    expect((await patch(token, id, { handoffBy: 'not-a-uuid' })).status).toBe(400);
    expect((await patch(token, id, { handoffBy: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await patch(token, id, { trackingNumber: '1Z999AA10123456784', carrier: 'UPS' })).status).toBe(400);

    expect((await patch(token, id, { source: 'reddit', handoffMethod: 'pickup', handoffBy: user.id })).status).toBe(200);
    let o = await readOrder(token, id);
    expect([o.source, o.handoffMethod, o.handoffBy?.id]).toEqual(['reddit', 'pickup', user.id]);
    const meta = (await events(id)).filter(e => e.kind === 'meta_changed').at(-1)!;
    const changed = meta.detail.changes as { field: string; from: unknown; to: unknown }[];
    expect(changed.find(ch => ch.field === 'handoff_by')).toMatchObject({ from: null, to: user.name });
    expect(changed.map(ch => ch.field).sort()).toEqual(['handoff_by', 'handoff_method', 'source']);

    expect((await patch(token, id, { handoffMethod: 'label' })).status).toBe(200);
    o = await readOrder(token, id);
    expect(o.handoffMethod).toBe('label');
    expect(o.handoffBy).toBeNull();
    expect(o.blockers).toContain('missingTracking');
  });

  it('a tracking number on PATCH makes the box: created, fixed in place, adopted, refused, unlinked', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'self');
    expect((await patch(token, id, { source: 'facebook', handoffMethod: 'label', ...label })).status).toBe(200);
    let o = await readOrder(token, id);
    expect(o.package).toMatchObject({ trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'purchased', source: 'facebook' });
    expect(o.blockers).not.toContain('missingTracking');
    const pkgId = o.package!.id;

    // A typo fix: same row, tracking columns reset.
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'in_transit', tracking_status = 'moving', tracking_registered_at = NOW() WHERE id = ${pkgId}`;
    expect((await patch(token, id, { trackingNumber: '1Z999AA10123456791', carrier: 'UPS' })).status).toBe(200);
    o = await readOrder(token, id);
    expect(o.package!.id).toBe(pkgId);
    expect(o.package).toMatchObject({ trackingNumber: '1Z999AA10123456791', status: 'purchased', trackingStatus: null });
    const [row] = await sql`SELECT tracking_registered_at FROM packages WHERE id = ${pkgId}`;
    expect(row.tracking_registered_at).toBeNull();

    // The number another PO tracks is refused, naming it.
    const other = await createOrder(token, 'self');
    const taken = await patch(token, other, { handoffMethod: 'label', trackingNumber: '1Z999AA10123456791', carrier: 'UPS' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(new RegExp(`already being tracked on ${id}`));

    // A standalone package with the number is adopted, not duplicated.
    const solo = await api<{ package: { id: string } }>('POST', '/api/packages', {
      token, body: { trackingNumber: '9400111899223197428490', carrier: 'USPS', source: 'other' },
    });
    expect(solo.status).toBe(201);
    expect((await patch(token, other, { handoffMethod: 'label', trackingNumber: '9400111899223197428490', carrier: 'USPS' })).status).toBe(200);
    const adopted = await readOrder(token, other);
    expect(adopted.package?.id).toBe(solo.body.package.id);
    expect((await sql`SELECT count(*)::int AS n FROM packages WHERE tracking_number = '9400111899223197428490'`)[0].n).toBe(1);

    // Label → pickup parts with the box: unlinked, still deletable.
    expect((await patch(token, other, { handoffMethod: 'pickup' })).status).toBe(200);
    expect((await readOrder(token, other)).package).toBeNull();
    const [orphan] = await sql`SELECT order_id FROM packages WHERE id = ${solo.body.package.id}`;
    expect(orphan.order_id).toBeNull();
    expect((await api('DELETE', `/api/packages/${solo.body.package.id}`, { token })).status).toBe(200);
  });

  it('a PO minted from a package hands off with its own tracking number', async () => {
    const { token } = await loginAs(MARCUS);
    const solo = await api<{ package: { id: string } }>('POST', '/api/packages', {
      token, body: { trackingNumber: '1Z999AA10123456784', carrier: 'UPS', source: 'facebook' },
    });
    expect(solo.status).toBe(201);
    // A manager may mint the PO before delivery; it belongs to whoever tracked the box.
    const { token: mTok } = await loginAs(ALEX);
    const made = await api<{ orderId: string }>('POST', `/api/packages/${solo.body.package.id}/create-po`, { token: mTok, body: {} });
    expect(made.status).toBe(201);
    const id = made.body.orderId;
    expect((await patch(token, id, { addLines: [LINE], handoffMethod: 'label' })).status).toBe(200);
    await attachChat(token, id);
    const r = await api<{ packageId: string }>('POST', `/api/orders/${id}/handoff`, {
      token, body: { warehouseId: 'WH-LA1', handoff: label, payment: 'self' },
    });
    expect(r.status).toBe(200);
    expect(r.body.packageId).toBe(solo.body.package.id);
  });
});

describe('hand-off — the pre-release review fixes', () => {
  beforeEach(async () => { await resetDb(); });

  const patch = (token: string, id: string, body: Record<string, unknown>) =>
    api<{ error?: string; lifecycle: string }>('PATCH', `/api/orders/${id}`, { token, body });

  it('handing off as Self or Cash drops a saved PayPal id and links nothing', async () => {
    const { token, user } = await loginAs(MARCUS);
    const sql = getTestDb();
    // Saved as company/PayPal with an id, then handed off as self-paid.
    const selfId = await createOrder(token, 'company');
    expect((await patch(token, selfId, { paymentMethod: 'paypal', paypalTxnId: '7AB12345CD678901E' })).status).toBe(200);
    await attachChat(token, selfId);
    const r = await api<{ paymentsLinked: number }>('POST', `/api/orders/${selfId}/handoff`, {
      token, body: { warehouseId: 'WH-LA1', source: 'other', handoff: pickup(user.id), payment: 'self' },
    });
    expect(r.status).toBe(200);
    expect(r.body.paymentsLinked).toBe(0);
    const o = await readOrder(token, selfId);
    expect(o.lifecycle).toBe('in_transit');
    expect(o.paypalTxnId).toBeNull();
    expect((await sql`SELECT 1 FROM bank_transactions WHERE order_id = ${selfId}`).length).toBe(0);

    // Same for cash: the id belongs to the PayPal method only.
    const cashId = await createOrder(token, 'company');
    expect((await patch(token, cashId, { paymentMethod: 'paypal', paypalTxnId: '7AB12345CD678901E' })).status).toBe(200);
    await attachPaymentShot(token, cashId);
    expect((await api('POST', `/api/orders/${cashId}/handoff`, {
      token, body: { warehouseId: 'WH-LA1', source: 'other', handoff: pickup(user.id), payment: 'company', paymentMethod: 'cash' },
    })).status).toBe(200);
    expect((await readOrder(token, cashId)).paypalTxnId).toBeNull();
  });

  it('PATCH clears the PayPal id on a flip to Self or Cash, and only on the flip', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createOrder(token, 'company');
    expect((await patch(token, id, { paymentMethod: 'paypal', paypalTxnId: '7AB12345CD678901E' })).status).toBe(200);
    expect((await patch(token, id, { payment: 'self' })).status).toBe(200);
    expect((await readOrder(token, id)).paypalTxnId).toBeNull();

    // A self-paid PO can carry an id create-po scanned off a screenshot; a
    // later save that says nothing about the payment leaves it alone.
    const sql = getTestDb();
    await sql`UPDATE orders SET paypal_txn_id = 'SCANNED000000001' WHERE id = ${id}`;
    expect((await patch(token, id, { notes: 'still here' })).status).toBe(200);
    expect((await readOrder(token, id)).paypalTxnId).toBe('SCANNED000000001');
    expect((await patch(token, id, { payment: 'company', paymentMethod: 'cash' })).status).toBe(200);
    expect((await readOrder(token, id)).paypalTxnId).toBeNull();
  });

  it('a deactivated saved collector is no collector: the empty-body hand-off refuses', async () => {
    const { token, user } = await loginAs(MARCUS);
    const { user: priya } = await loginAs(PRIYA);
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    expect((await patch(token, id, { source: 'local', handoffMethod: 'pickup', handoffBy: priya.id })).status).toBe(200);
    expect((await readOrder(token, id)).blockers).toEqual([]);
    const sql = getTestDb();
    await sql`UPDATE users SET active = FALSE WHERE id = ${priya.id}`;

    const refused = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, { token, body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/who is collecting/i);
    const o = await readOrder(token, id);
    expect(o.lifecycle).toBe('draft');
    expect(o.handoffBy?.id).toBe(priya.id);
    // Naming a live collector recovers it.
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { handoff: pickup(user.id) } })).status).toBe(200);
    expect((await events(id)).find(e => e.kind === 'handoff')?.detail).toMatchObject({ byUserId: user.id, byName: user.name });
  });

  it('another member\'s standalone box is not adopted; a manager\'s pull still is, re-registering on a new carrier', async () => {
    const { token: marcus } = await loginAs(MARCUS);
    const { token: priya } = await loginAs(PRIYA);
    const { token: alex } = await loginAs(ALEX);
    const sql = getTestDb();
    const solo = await api<{ package: { id: string } }>('POST', '/api/packages', {
      token: priya, body: { trackingNumber: '9400111899223197428490', carrier: 'USPS', source: 'other' },
    });
    expect(solo.status).toBe(201);

    const mine = await createOrder(marcus, 'self');
    const grab = await patch(marcus, mine, { handoffMethod: 'label', trackingNumber: '9400111899223197428490', carrier: 'USPS' });
    expect(grab.status).toBe(409);
    expect(grab.body.error).toMatch(/Shipping page/);
    expect(grab.body.error).not.toMatch(/PO-/);
    expect((await sql`SELECT order_id FROM packages WHERE id = ${solo.body.package.id}`)[0].order_id).toBeNull();

    await sql`UPDATE packages SET tracking_registered_at = NOW() WHERE id = ${solo.body.package.id}`;
    const theirs = await createOrder(priya, 'self');
    expect((await patch(alex, theirs, { handoffMethod: 'label', trackingNumber: '9400111899223197428490', carrier: 'UPS' })).status).toBe(200);
    const [row] = await sql`SELECT order_id, carrier, tracking_registered_at FROM packages WHERE id = ${solo.body.package.id}`;
    expect(row).toMatchObject({ order_id: theirs, carrier: 'UPS', tracking_registered_at: null });
  });

  it('a delivered box is history: no flip away from label, no re-typed number', async () => {
    const { token, user } = await loginAs(MARCUS);
    const { token: alex } = await loginAs(ALEX);
    const id = await createOrder(token, 'self');
    expect((await patch(token, id, { source: 'facebook', handoffMethod: 'label', ...label })).status).toBe(200);
    const pkgId = (await readOrder(token, id)).package!.id;
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered', tracking_status = 'delivered' WHERE id = ${pkgId}`;

    const flip = await patch(alex, id, { handoffMethod: 'pickup' });
    expect(flip.status).toBe(409);
    expect(flip.body.error).toMatch(/already been delivered/);
    const retype = await patch(alex, id, { trackingNumber: '1Z999AA10123456791', carrier: 'UPS' });
    expect(retype.status).toBe(409);
    const [row] = await sql`SELECT order_id, status, tracking_number FROM packages WHERE id = ${pkgId}`;
    expect(row).toMatchObject({ order_id: id, status: 'delivered', tracking_number: '1Z999AA10123456784' });
    expect((await readOrder(token, id)).handoffMethod).toBe('label');

    // The hand-off's own flip is refused the same way.
    await attachChat(token, id);
    const ho = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, {
      token, body: { warehouseId: 'WH-LA1', handoff: pickup(user.id), payment: 'self' },
    });
    expect(ho.status).toBe(409);
    expect(ho.body.error).toMatch(/already been delivered/);
    expect((await readOrder(token, id)).lifecycle).toBe('draft');
  });

  it('a Draft with no warehouse lists it as a blocker and no door lets it out until one is set', async () => {
    const { token, user } = await loginAs(MARCUS);
    const { token: alex } = await loginAs(ALEX);
    const sql = getTestDb();
    const id = await createOrder(token, 'self');
    await attachChat(token, id);
    await sql`UPDATE orders SET warehouse_id = NULL WHERE id = ${id}`;
    expect((await readOrder(token, id)).blockers).toEqual(['missingWarehouse', 'missingSource', 'missingDelivery']);

    const refused = await api<{ error: string }>('POST', `/api/orders/${id}/handoff`, {
      token, body: { source: 'other', handoff: pickup(user.id), payment: 'self' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/receiving warehouse/i);
    // Not a hand-off nicety: a manager stage-jump is held to it too.
    const jumped = await api<{ error: string }>('POST', `/api/orders/${id}/advance`, { token: alex, body: {} });
    expect(jumped.status).toBe(409);
    expect(jumped.body.error).toMatch(/receiving warehouse/i);
    expect((await readOrder(token, id)).lifecycle).toBe('draft');

    expect((await api('POST', `/api/orders/${id}/handoff`, {
      token, body: { warehouseId: 'WH-LA1', source: 'other', handoff: pickup(user.id), payment: 'self' },
    })).status).toBe(200);
    expect((await readOrder(token, id)).warehouse?.id).toBe('WH-LA1');
  });

  it('a PO minted from a box already knows it came by label', async () => {
    const { token } = await loginAs(MARCUS);
    const solo = await api<{ package: { id: string } }>('POST', '/api/packages', {
      token, body: { trackingNumber: '1Z999AA10123456784', carrier: 'UPS', source: 'facebook' },
    });
    expect(solo.status).toBe(201);
    const { token: alex } = await loginAs(ALEX);
    const made = await api<{ orderId: string }>('POST', `/api/packages/${solo.body.package.id}/create-po`, { token: alex, body: {} });
    expect(made.status).toBe(201);
    const o = await readOrder(token, made.body.orderId);
    expect(o.handoffMethod).toBe('label');
    expect(o.package?.id).toBe(solo.body.package.id);
    // The seeded owner has no default warehouse, so that is what is left.
    expect(o.blockers).not.toContain('missingDelivery');
    expect(o.blockers).not.toContain('missingTracking');
    expect(o.blockers).toContain('missingWarehouse');
  });
});
