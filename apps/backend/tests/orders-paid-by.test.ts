import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS, PRIYA } from './helpers/auth';

// Who paid the supplier on a self-paid PO (orders.paid_by, 0198): a manager
// in person or the purchaser. The Business Account ('company') names nobody,
// and every write path keeps the two in step.

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'PAID-BY-1',
  condition: 'Pulled — Tested', qty: 1, unitCost: 50,
};

type Payer = { id: string; name: string } | null;
type Read = { order: { payment: string; paidBy: Payer; paymentMethod: string | null } };

async function createOrder(token: string, body: Record<string, unknown> = {}) {
  return api<{ id: string; error?: string }>('POST', '/api/orders', {
    token, body: { category: 'RAM', warehouseId: 'WH-LA1', lines: [LINE], ...body },
  });
}

async function readOrder(token: string, id: string) {
  const got = await api<Read>('GET', `/api/orders/${id}`, { token });
  expect(got.status).toBe(200);
  return got.body.order;
}

async function storedPayer(id: string): Promise<string | null> {
  const [row] = await getTestDb()<{ paid_by: string | null }[]>`SELECT paid_by FROM orders WHERE id = ${id}`;
  return row!.paid_by;
}

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chat.png', { type: 'image/png' });

describe('a self-paid PO names who paid', () => {
  beforeEach(async () => { await resetDb(); });

  it('create: self with no payer names the owner; company names nobody', async () => {
    const marcus = await loginAs(MARCUS);
    const self = await createOrder(marcus.token, { payment: 'self' });
    expect(self.status).toBe(201);
    expect(await storedPayer(self.body.id)).toBe(marcus.user.id);
    expect((await readOrder(marcus.token, self.body.id)).paidBy).toEqual({ id: marcus.user.id, name: expect.any(String) });

    const company = await createOrder(marcus.token, { payment: 'company', paidByUserId: marcus.user.id });
    expect(company.status).toBe(201);
    expect(await storedPayer(company.body.id)).toBeNull();
    expect((await readOrder(marcus.token, company.body.id)).paidBy).toBeNull();
  });

  it('create: a purchaser may name a manager, not another purchaser', async () => {
    const marcus = await loginAs(MARCUS);
    const alex = await loginAs(ALEX);
    const priya = await loginAs(PRIYA);
    const ok = await createOrder(marcus.token, { payment: 'self', paidByUserId: alex.user.id });
    expect(ok.status).toBe(201);
    expect(await storedPayer(ok.body.id)).toBe(alex.user.id);

    const bad = await createOrder(marcus.token, { payment: 'self', paidByUserId: priya.user.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/active manager or the purchaser/);
    expect((await createOrder(marcus.token, { payment: 'self', paidByUserId: 'not-a-uuid' })).status).toBe(400);
  });

  it('PATCH: the payer follows the payment, and a change is one Activity line', async () => {
    const marcus = await loginAs(MARCUS);
    const alex = await loginAs(ALEX);
    const sofia = await loginAs(SOFIA);
    const { body: { id } } = await createOrder(marcus.token, { payment: 'self' });

    const toAlex = await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { paidByUserId: alex.user.id } });
    expect(toAlex.status).toBe(200);
    expect(await storedPayer(id)).toBe(alex.user.id);

    // A notes-only save keeps the record; so does an explicit null.
    expect((await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { notes: 'hi' } })).status).toBe(200);
    expect((await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { paidByUserId: null } })).status).toBe(200);
    expect(await storedPayer(id)).toBe(alex.user.id);

    // Flipping to the Business Account clears it, a payer sent alongside or not.
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: marcus.token, body: { payment: 'company', paymentMethod: 'cash', paidByUserId: sofia.user.id },
    })).status).toBe(200);
    expect(await storedPayer(id)).toBeNull();

    // Back to self without a payer names the owner again.
    expect((await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { payment: 'self' } })).status).toBe(200);
    expect(await storedPayer(id)).toBe(marcus.user.id);

    const events = await getTestDb()<{ detail: { changes?: { field: string; from: unknown; to: unknown }[] } }[]>`
      SELECT detail FROM order_events WHERE order_id = ${id} AND kind = 'meta_changed' ORDER BY created_at, id`;
    const payerChanges = events.flatMap(e => (e.detail.changes ?? []).filter(ch => ch.field === 'paid_by'));
    expect(payerChanges.map(ch => [ch.from, ch.to])).toEqual([
      [expect.any(String), expect.any(String)], // Marcus → Alex, by name
      [expect.any(String), null],               // → Business Account
      [null, expect.any(String)],               // → Marcus
    ]);
    // Names, not ids, as handoff_by is written.
    expect(payerChanges[0]!.to).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('hand-off: writes the payer with the payment it was given', async () => {
    const marcus = await loginAs(MARCUS);
    const alex = await loginAs(ALEX);
    const { body: { id } } = await createOrder(marcus.token, { payment: 'company' });
    const up = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`, { file: PNG() }, { token: marcus.token });
    expect(up.status).toBe(200);
    const ho = await api('POST', `/api/orders/${id}/handoff`, {
      token: marcus.token,
      body: { source: 'local', handoff: { method: 'pickup', byUserId: marcus.user.id }, payment: 'self', paidByUserId: alex.user.id },
    });
    expect(ho.status).toBe(200);
    expect(await storedPayer(id)).toBe(alex.user.id);
    const order = await readOrder(alex.token, id);
    expect(order.payment).toBe('self');
    expect(order.paymentMethod).toBeNull();
    expect(order.paidBy).toMatchObject({ id: alex.user.id });
  });

  it('a new owner takes over a payer that was the old owner', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const alex = await loginAs(ALEX);
    const { body: { id } } = await createOrder(marcus.token, { payment: 'self' });
    const reassign = (to: string, body: Record<string, unknown> = {}) =>
      api('PATCH', `/api/orders/${id}`, { token: alex.token, body: { onBehalfOfUserId: to, ...body } });

    expect((await reassign(priya.user.id)).status).toBe(200);
    expect(await storedPayer(id)).toBe(priya.user.id);
    const events = await getTestDb()<{ detail: { changes?: { field: string; from: unknown; to: unknown }[] } }[]>`
      SELECT detail FROM order_events WHERE order_id = ${id} AND kind = 'meta_changed' ORDER BY created_at, id`;
    expect(events.flatMap(e => e.detail.changes ?? []).filter(ch => ch.field === 'paid_by'))
      .toEqual([{ field: 'paid_by', from: 'Marcus Wright', to: 'Priya Shah' }]);

    // A manager who paid stays the payer whoever owns the PO.
    expect((await api('PATCH', `/api/orders/${id}`, { token: alex.token, body: { paidByUserId: alex.user.id } })).status).toBe(200);
    expect((await reassign(marcus.user.id)).status).toBe(200);
    expect(await storedPayer(id)).toBe(alex.user.id);
    // The payer on file echoed back with the move is no pick: it stays.
    expect((await reassign(priya.user.id, { paidByUserId: alex.user.id })).status).toBe(200);
    expect(await storedPayer(id)).toBe(alex.user.id);
    // A purchaser pays only for their own PO, so the old owner can't be picked
    // by the request that hands it over; the new one can.
    const old = await reassign(marcus.user.id, { paidByUserId: priya.user.id });
    expect(old.status).toBe(400);
    expect((old.body as { error: string }).error).toMatch(/active manager or the purchaser/);
    expect(await storedPayer(id)).toBe(alex.user.id);
    expect((await reassign(marcus.user.id, { paidByUserId: marcus.user.id })).status).toBe(200);
    expect(await storedPayer(id)).toBe(marcus.user.id);
  });

  it('a move and another change log the payer once', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const alex = await loginAs(ALEX);
    const { body: { id } } = await createOrder(marcus.token, { payment: 'self' });
    const moved = await api('PATCH', `/api/orders/${id}`, {
      token: alex.token, body: { onBehalfOfUserId: priya.user.id, notes: 'moved to Priya' },
    });
    expect(moved.status).toBe(200);
    const events = await getTestDb()<{ detail: { changes?: { field: string; from: unknown; to: unknown }[] } }[]>`
      SELECT detail FROM order_events WHERE order_id = ${id} AND kind = 'meta_changed' ORDER BY created_at, id`;
    expect(events.flatMap(e => e.detail.changes ?? []).filter(ch => ch.field === 'paid_by'))
      .toEqual([{ field: 'paid_by', from: 'Marcus Wright', to: 'Priya Shah' }]);
  });

  it('only a payer the request picks is judged: one deactivated since still paid', async () => {
    const marcus = await loginAs(MARCUS);
    const sofia = await loginAs(SOFIA);
    const { body: { id } } = await createOrder(marcus.token, { payment: 'self', paidByUserId: sofia.user.id });
    await getTestDb()`UPDATE users SET active = FALSE WHERE id = ${sofia.user.id}`;

    // The editors send the payer on file back with every save.
    const echo = await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { paidByUserId: sofia.user.id, notes: 'x' } });
    expect(echo.status).toBe(200);
    const up = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`, { file: PNG() }, { token: marcus.token });
    expect(up.status).toBe(200);
    const ho = await api('POST', `/api/orders/${id}/handoff`, {
      token: marcus.token,
      body: { source: 'local', handoff: { method: 'pickup', byUserId: marcus.user.id }, payment: 'self', paidByUserId: sofia.user.id },
    });
    expect(ho.status).toBe(200);
    expect(await storedPayer(id)).toBe(sofia.user.id);

    // Picked anew, she is judged as she stands.
    const { body: { id: other } } = await createOrder(marcus.token, { payment: 'self' });
    const picked = await api('PATCH', `/api/orders/${other}`, { token: marcus.token, body: { paidByUserId: sofia.user.id } });
    expect(picked.status).toBe(400);
  });

  it('closed book: a manager cannot move the payer without reopening', async () => {
    const marcus = await loginAs(MARCUS);
    const alex = await loginAs(ALEX);
    const sofia = await loginAs(SOFIA);
    const { body: { id } } = await createOrder(marcus.token, { payment: 'self' });
    const up = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`, { file: PNG() }, { token: marcus.token });
    expect(up.status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/advance`, { token: marcus.token, body: {} })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await api('POST', `/api/orders/${id}/advance`, { token: alex.token, body: {} })).status).toBe(200);
    }
    const moved = await api('PATCH', `/api/orders/${id}`, { token: alex.token, body: { paidByUserId: sofia.user.id } });
    expect(moved.status).toBe(409);
    // Echoing the record is not a change.
    expect((await api('PATCH', `/api/orders/${id}`, { token: alex.token, body: { paidByUserId: marcus.user.id, notes: 'x' } })).status).toBe(200);
    expect(await storedPayer(id)).toBe(marcus.user.id);
  });

  it('the list, the export and the book all name the payer', async () => {
    const marcus = await loginAs(MARCUS);
    const alex = await loginAs(ALEX);
    const { body: { id } } = await createOrder(marcus.token, { payment: 'self', paidByUserId: alex.user.id });

    const list = await api<{ orders: { id: string; paidBy: Payer }[] }>('GET', '/api/orders', { token: marcus.token });
    expect(list.body.orders.find(o => o.id === id)?.paidBy).toMatchObject({ id: alex.user.id });

    type Target = { target: { payerId: string | null; payerName: string | null; payerBusiness: boolean } };
    const cost = await api<Target>('GET', `/api/accounting/by-order/${id}?kind=purchase`, { token: alex.token });
    expect(cost.status).toBe(200);
    expect(cost.body.target).toMatchObject({ payerId: alex.user.id, payerName: 'Alex Chen', payerBusiness: false });
    const commission = await api<Target>('GET', `/api/accounting/by-order/${id}?kind=commission`, { token: alex.token });
    expect(commission.body.target).toMatchObject({ payerId: null, payerName: null, payerBusiness: false });

    // The Business Account reads as such on both lenses: a cost paid as
    // 'company', and a commission the company paid.
    expect((await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { payment: 'company', paymentMethod: 'cash' } })).status).toBe(200);
    expect((await api('PUT', `/api/orders/${id}/commission-paid-by`, { token: alex.token, body: { company: true } })).status).toBe(200);
    const costNow = await api<Target>('GET', `/api/accounting/by-order/${id}?kind=purchase`, { token: alex.token });
    expect(costNow.body.target).toMatchObject({ payerId: null, payerName: null, payerBusiness: true });
    const commissionNow = await api<Target>('GET', `/api/accounting/by-order/${id}?kind=commission`, { token: alex.token });
    expect(commissionNow.body.target).toMatchObject({ payerId: null, payerBusiness: true });
    expect((await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { payment: 'self', paidByUserId: alex.user.id } })).status).toBe(200);
    const picked = await api<{ candidates: { id: string; payerId: string | null }[] }>(
      'GET', `/api/accounting/targets?kind=purchase&q=${id}`, { token: alex.token });
    expect(picked.body.candidates).toEqual([expect.objectContaining({ id, payerId: alex.user.id })]);

    const names = await api<{ items: { id: string; role: string }[] }>('GET', '/api/members/names', { token: marcus.token });
    expect(names.status).toBe(200);
    expect(names.body.items.find(m => m.id === alex.user.id)?.role).toBe('manager');
  });
});
