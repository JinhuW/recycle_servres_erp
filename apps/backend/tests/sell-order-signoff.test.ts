import { beforeEach, describe, it, expect } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { firstCustomerId } from './helpers/fixtures';
import { eventsOf } from './helpers/sellOrderEvents';

// Done needs a current sign-off from every active manager (seed: Alex, Sofia).
// A sign-off approves the order as it stood — the customer, the currency and
// what each line sells at what native price — so changing any of that voids it.

const ALEX_NAME = 'Alex Chen';
const SOFIA_NAME = 'Sofia Reyes';

type Signoff = {
  managers: { id: string; name: string; required: boolean; signedAt: string | null; stale: boolean }[];
  complete: boolean;
  fingerprint: string;
};
type Line = {
  inventoryId: string | null; category: string; label: string; sub: string | null;
  partNumber: string | null; qty: number; nativeUnitPrice: number;
  warehouseId: string | null; condition: string | null;
};
type Detail = { order: { status: string; signoff: Signoff; lines: Line[] } };

let alex: string;
let sofia: string;

async function newDraft(opts: { qty?: number; currency?: string } = {}): Promise<{ id: string; lineId: string }> {
  const line = await freeSellableLine(alex, opts.qty ?? 1);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: alex,
    body: {
      customerId: await firstCustomerId(alex),
      ...(opts.currency ? { currency: opts.currency } : {}),
      lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty: opts.qty ?? 1, unitPrice: 90 }],
    },
  });
  expect(r.status).toBe(201);
  return { id: r.body.id, lineId: line.id };
}

const detail = async (id: string) => (await api<Detail>('GET', `/api/sell-orders/${id}`, { token: alex })).body.order;
// Signs what the order holds now, as the page would after a fresh read.
const sign = async (id: string, token: string) => api<{ signoff: Signoff; error?: string }>(
  'POST', `/api/sell-orders/${id}/signoff`, { token, body: { fingerprint: (await detail(id)).signoff.fingerprint } });
const withdraw = (id: string, token: string) => api<{ signoff: Signoff }>('DELETE', `/api/sell-orders/${id}/signoff`, { token });
const toDone = (id: string) => api<{ error?: string; missingSignoff?: string[] }>(
  'POST', `/api/sell-orders/${id}/status`, { token: alex, body: { to: 'Done', note: 'paid' } });

// The edit page resends every line as it stands.
const resendable = (lines: Line[]) => lines.map(l => ({
  inventoryId: l.inventoryId, category: l.category, label: l.label, subLabel: l.sub,
  partNumber: l.partNumber, qty: l.qty, unitPrice: l.nativeUnitPrice,
  warehouseId: l.warehouseId, condition: l.condition,
}));

async function signBoth(id: string): Promise<void> {
  expect((await sign(id, alex)).status).toBe(200);
  expect((await sign(id, sofia)).status).toBe(200);
}

describe('sell-order sign-off before Done', () => {
  beforeEach(async () => {
    await resetDb();
    alex = (await loginAs(ALEX)).token;
    sofia = (await loginAs(SOFIA)).token;
  });

  it('refuses Done until every active manager has signed, naming who is missing', async () => {
    const { id } = await newDraft();

    const none = await toDone(id);
    expect(none.status).toBe(409);
    expect(none.body.missingSignoff?.sort()).toEqual([ALEX_NAME, SOFIA_NAME]);

    const first = await sign(id, alex);
    expect(first.status).toBe(200);
    expect(first.body.signoff.complete).toBe(false);
    const one = await toDone(id);
    expect(one.status).toBe(409);
    expect(one.body.missingSignoff).toEqual([SOFIA_NAME]);
    expect(one.body.error).toMatch(/Sofia Reyes/);

    const second = await sign(id, sofia);
    expect(second.body.signoff.complete).toBe(true);
    expect((await toDone(id)).status).toBe(200);
    expect((await detail(id)).status).toBe('Done');
  });

  it('reports each manager on the order detail', async () => {
    const { id } = await newDraft();
    await sign(id, alex);
    const s = (await detail(id)).signoff;
    expect(s.complete).toBe(false);
    const byName = Object.fromEntries(s.managers.map(m => [m.name, m]));
    expect(byName[ALEX_NAME]).toMatchObject({ required: true, stale: false });
    expect(byName[ALEX_NAME].signedAt).not.toBeNull();
    expect(byName[SOFIA_NAME]).toMatchObject({ required: true, signedAt: null, stale: false });
  });

  it('does not wait on an inactive manager', async () => {
    const { id } = await newDraft();
    await getTestDb()`UPDATE users SET active = FALSE WHERE email = ${SOFIA}`;
    await sign(id, alex);
    expect((await detail(id)).signoff.managers.map(m => m.name)).toEqual([ALEX_NAME]);
    expect((await toDone(id)).status).toBe(200);
  });

  it('a qty or price change voids every sign-off; signing again restores it', async () => {
    const { id } = await newDraft({ qty: 2 });
    await signBoth(id);
    const lines = resendable((await detail(id)).lines);

    const patch = await api('PATCH', `/api/sell-orders/${id}`, {
      token: alex, body: { lines: [{ ...lines[0], unitPrice: 95 }] },
    });
    expect(patch.status).toBe(200);
    const after = (await detail(id)).signoff;
    expect(after.complete).toBe(false);
    expect(after.managers.every(m => m.stale)).toBe(true);
    expect((await toDone(id)).status).toBe(409);

    await signBoth(id);
    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token: alex, body: { lines: [{ ...lines[0], unitPrice: 95, qty: 1 }] },
    })).status).toBe(200);
    expect((await detail(id)).signoff.complete).toBe(false);

    await signBoth(id);
    expect((await toDone(id)).status).toBe(200);
  });

  it('notes, the receiver and resending identical lines keep the sign-offs', async () => {
    const { id } = await newDraft();
    await signBoth(id);
    const [me] = await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = ${SOFIA}`;

    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token: alex, body: { notes: 'call before shipping', paymentReceivedBy: me.id },
    })).status).toBe(200);
    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token: alex, body: { lines: resendable((await detail(id)).lines).reverse() },
    })).status).toBe(200);

    expect((await detail(id)).signoff.complete).toBe(true);
    expect((await toDone(id)).status).toBe(200);
  });

  it('a foreign-currency order keeps its sign-offs when the USD snapshot moves', async () => {
    const { id } = await newDraft({ currency: 'CNY' });
    await signBoth(id);
    // What a line rewrite at a new rate does: USD moves, the native price doesn't.
    await getTestDb()`UPDATE sell_order_lines SET unit_price = unit_price + 1 WHERE sell_order_id = ${id}`;
    expect((await detail(id)).signoff.complete).toBe(true);
  });

  it('moving a line to another lot voids the sign-offs, even with the same text and price', async () => {
    const { id, lineId } = await newDraft();
    await signBoth(id);
    const other = await freeSellableLine(alex, 1, new Set([lineId]));
    const [line] = resendable((await detail(id)).lines);
    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token: alex, body: { lines: [{ ...line, inventoryId: other.id }] },
    })).status).toBe(200);
    expect((await detail(id)).signoff.complete).toBe(false);
  });

  it('a negotiated total voids the sign-offs', async () => {
    const { id } = await newDraft({ qty: 2 });
    await signBoth(id);
    expect((await api('POST', `/api/sell-orders/${id}/adjust-price`, {
      token: alex, body: { targetTotal: 150 },
    })).status).toBe(200);
    expect((await detail(id)).signoff.complete).toBe(false);
    expect((await toDone(id)).status).toBe(409);
  });

  it('a PO archive that takes a line off voids the sign-offs', async () => {
    const { id, lineId } = await newDraft();
    await signBoth(id);
    const [{ order_id }] = await getTestDb()<{ order_id: string }[]>`
      SELECT order_id FROM order_lines WHERE id = ${lineId}`;
    expect((await api('POST', `/api/orders/${order_id}/archive`, {
      token: alex, body: { removeFromSellOrders: true },
    })).status).toBe(200);
    expect((await detail(id)).signoff.complete).toBe(false);
  });

  it('signs only the version the manager reviewed', async () => {
    const { id } = await newDraft({ qty: 2 });
    const seen = (await detail(id)).signoff.fingerprint;
    const lines = resendable((await detail(id)).lines);
    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token: alex, body: { lines: [{ ...lines[0], unitPrice: 60 }] },
    })).status).toBe(200);

    const late = await api<{ error: string }>('POST', `/api/sell-orders/${id}/signoff`, {
      token: sofia, body: { fingerprint: seen },
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/changed/);
    expect((await detail(id)).signoff.managers.every(m => m.signedAt === null)).toBe(true);

    expect((await api('POST', `/api/sell-orders/${id}/signoff`, { token: sofia, body: {} })).status).toBe(400);
  });

  it('withdrawing a sign-off blocks Done again', async () => {
    const { id } = await newDraft();
    await signBoth(id);
    const w = await withdraw(id, sofia);
    expect(w.status).toBe(200);
    expect(w.body.signoff.complete).toBe(false);
    const r = await toDone(id);
    expect(r.status).toBe(409);
    expect(r.body.missingSignoff).toEqual([SOFIA_NAME]);
  });

  it('only managers sign, and only on an open order', async () => {
    const { id } = await newDraft();
    const { token: pur } = await loginAs(MARCUS);
    expect((await sign(id, pur)).status).toBe(403);
    expect((await withdraw(id, pur)).status).toBe(403);
    expect((await api('POST', '/api/sell-orders/SO-NOPE/signoff', { token: alex, body: { fingerprint: 'x' } })).status).toBe(404);

    await signBoth(id);
    expect((await toDone(id)).status).toBe(200);
    expect((await sign(id, alex)).status).toBe(409);
    expect((await withdraw(id, alex)).status).toBe(409);

    const { id: closed } = await newDraft();
    expect((await api('POST', `/api/sell-orders/${closed}/status`, {
      token: alex, body: { to: 'Closed', closeReasonId: 'other' },
    })).status).toBe(200);
    expect((await sign(closed, alex)).status).toBe(409);
  });

  it('reopening a Closed order clears its sign-offs', async () => {
    const { id } = await newDraft();
    await signBoth(id);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: alex, body: { to: 'Closed', closeReasonId: 'other' },
    })).status).toBe(200);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: alex, body: { to: 'Draft', note: 'customer came back' },
    })).status).toBe(200);
    const s = (await detail(id)).signoff;
    expect(s.complete).toBe(false);
    expect(s.managers.every(m => m.signedAt === null)).toBe(true);
  });

  it('a sign-off notifies only the managers still to sign, and both moves are in the history', async () => {
    const { id } = await newDraft();
    const sql = getTestDb();
    const unread = async (email: string) => (await sql<{ title: string }[]>`
      SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE u.email = ${email} AND n.kind = 'sell_order_signoff'`).map(r => r.title);

    await sign(id, alex);
    expect(await unread(SOFIA)).toEqual([`${ALEX_NAME} signed off sell order ${id}`]);
    expect(await unread(ALEX)).toEqual([]);

    await withdraw(id, alex);
    await withdraw(id, alex);   // nothing left to withdraw: no second event
    const kinds = (await eventsOf(id)).map(e => e.kind);
    expect(kinds.filter(k => k === 'signed_off')).toHaveLength(1);
    expect(kinds.filter(k => k === 'signoff_withdrawn')).toHaveLength(1);
  });
});
