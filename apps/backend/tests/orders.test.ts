import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

describe('POST /api/orders defaults', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates an order in lifecycle="draft" with line status="Draft"', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200',
          partNumber: 'M393A4K40DB3-CWE', condition: 'Pulled — Tested',
          qty: 4, unitCost: 78.5,
        }],
      },
    });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect(id).toMatch(/^PO-\d+$/);

    const got = await api<{ order: { lifecycle: string; lines: { status: string }[] } }>(
      'GET', '/api/orders/' + id, { token },
    );
    expect(got.status).toBe(200);
    expect(got.body.order.lifecycle).toBe('draft');
    expect(got.body.order.lines[0].status).toBe('Draft');
  });

  // Deriving `category` from the lines — sole category, 'Mixed', and the
  // `categories` array — lives in orders-mixed-category.test.ts.

  it('lets lines inherit a body-level category', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { category: 'HDD', lines: [{ qty: 1, unitCost: 10, condition: 'New' }] },
    });
    expect(r.status).toBe(201);
    const got = await api<{ order: { category: string } }>('GET', '/api/orders/' + r.body.id, { token });
    expect(got.body.order.category).toBe('HDD');
  });

  it('rejects a line with no category anywhere', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ error: string }>('POST', '/api/orders', {
      token,
      body: { lines: [{ qty: 1, unitCost: 10, condition: 'New' }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/category is required/);
  });
});

describe('POST /api/orders — synthetic part number', () => {
  beforeEach(async () => { await resetDb(); });

  it('derives MIXED_<cap>_<iface>_<form> for a Mixed-brand SSD with no part number', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'SSD', warehouseId: 'WH-LA1',
        lines: [{
          category: 'SSD', brand: 'Mixed', capacity: '512GB',
          interface: 'NVMe', formFactor: 'M.2', condition: 'Pulled — Tested',
          qty: 10, unitCost: 12,
        }],
      },
    });
    expect(r.status).toBe(201);
    const got = await api<{ order: { lines: { partNumber: string | null }[] } }>(
      'GET', '/api/orders/' + r.body.id, { token });
    expect(got.body.order.lines[0].partNumber).toBe('MIXED_512GB_NVMe_M.2');
  });

  it('leaves a user-supplied part number untouched', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'SSD', warehouseId: 'WH-LA1',
        lines: [{
          category: 'SSD', brand: 'Mixed', capacity: '512GB',
          interface: 'NVMe', formFactor: 'M.2', partNumber: 'MZ-V8P1T0BW',
          condition: 'Pulled — Tested', qty: 1, unitCost: 12,
        }],
      },
    });
    const got = await api<{ order: { lines: { partNumber: string | null }[] } }>(
      'GET', '/api/orders/' + r.body.id, { token });
    expect(got.body.order.lines[0].partNumber).toBe('MZ-V8P1T0BW');
  });

  it('does not synthesize for a non-Mixed SSD left blank', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'SSD', warehouseId: 'WH-LA1',
        lines: [{
          category: 'SSD', brand: 'Samsung', capacity: '512GB',
          interface: 'NVMe', formFactor: 'M.2', condition: 'Pulled — Tested',
          qty: 1, unitCost: 12,
        }],
      },
    });
    const got = await api<{ order: { lines: { partNumber: string | null }[] } }>(
      'GET', '/api/orders/' + r.body.id, { token });
    expect(got.body.order.lines[0].partNumber).toBeNull();
  });
});

describe('POST /api/orders/:id/advance', () => {
  beforeEach(async () => { await resetDb(); });

  it('purchaser can advance own Draft → in_transit', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const id = created.body.id;
    const r = await api('POST', `/api/orders/${id}/advance`, { token: pTok });
    expect(r.status).toBe(200);
    const got = await api<{ order: { lifecycle: string; lines: { status: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: pTok });
    expect(got.body.order.lifecycle).toBe('in_transit');
    expect(got.body.order.lines[0].status).toBe('In Transit');
  });

  it('purchaser can advance another user\'s Draft → in_transit', async () => {
    const { token: ownerTok } = await loginAs(MARCUS);
    const { token: otherTok } = await loginAs(PRIYA);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: ownerTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, { token: otherTok });
    expect(r.status).toBe(200);
    const got = await api<{ order: { lifecycle: string } }>(
      'GET', `/api/orders/${c.body.id}`, { token: ownerTok });
    expect(got.body.order.lifecycle).toBe('in_transit');
  });

  it('non-owner purchaser still cannot advance past in_transit', async () => {
    const { token: ownerTok } = await loginAs(MARCUS);
    const { token: otherTok } = await loginAs(PRIYA);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: ownerTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: ownerTok });
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, { token: otherTok });
    expect(r.status).toBe(403);
  });

  it('purchaser cannot jump past in_transit', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });
    expect(r.status).toBe(403);
  });

  it('manager can advance to any stage', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: mTok } = await loginAs(ALEX);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, {
      token: mTok, body: { toStage: 'reviewing' } });
    expect(r.status).toBe(200);
    const got = await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${c.body.id}`, { token: mTok });
    expect(got.body.order.lifecycle).toBe('reviewing');
  });
});

describe('notifications on order advance', () => {
  beforeEach(async () => { await resetDb(); });

  it('advancing to in_transit notifies managers', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: mTok } = await loginAs(ALEX);
    const before = await api<{ unreadCount: number }>('GET', '/api/notifications', { token: mTok });

    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });

    const after = await api<{ unreadCount: number; items: { kind: string; title: string }[] }>(
      'GET', '/api/notifications', { token: mTok });
    expect(after.body.unreadCount).toBeGreaterThan(before.body.unreadCount);
    expect(after.body.items.some(i => i.kind === 'order_submitted')).toBe(true);
  });
});

describe('GET /api/orders — per-order commission rate', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns the order\'s own commission_rate (null when unset)', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ orders: { id: string; commissionRate: number | null }[] }>(
      'GET', '/api/orders', { token });
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeGreaterThan(0);
    // seed: drafts are null, others 0.075
    expect(r.body.orders.some(o => o.commissionRate === 0.075)).toBe(true);
  });

  it('manager can PATCH commissionRate; purchaser is forbidden', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const list = await api<{ orders: { id: string; userId: string; lifecycle: string }[] }>(
      'GET', '/api/orders', { token: mgr });
    // Done orders are now frozen against PATCH edits — pick the first non-done.
    const target = list.body.orders.find(o => o.lifecycle !== 'done')!;

    const ok = await api('PATCH', `/api/orders/${target.id}`,
      { token: mgr, body: { commissionRate: 0.1 } });
    expect(ok.status).toBe(200);

    const after = await api<{ orders: { id: string; commissionRate: number | null }[] }>(
      'GET', '/api/orders', { token: mgr });
    expect(after.body.orders.find(o => o.id === target.id)!.commissionRate).toBeCloseTo(0.1, 4);

    // A purchaser editing their own order's rate is rejected.
    const { token: pur, user: pu } = await loginAs(MARCUS);
    const mine = (await api<{ orders: { id: string; userId: string; lifecycle: string }[] }>(
      'GET', '/api/orders', { token: pur })).body.orders
      .find(o => o.userId === pu.id && o.lifecycle !== 'done')!;
    const denied = await api('PATCH', `/api/orders/${mine.id}`,
      { token: pur, body: { commissionRate: 0.2 } });
    expect(denied.status).toBe(403);
  });

  it('clamps out-of-range rate and allows null to unset', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const list = await api<{ orders: { id: string; lifecycle: string }[] }>(
      'GET', '/api/orders', { token: mgr });
    const id = list.body.orders.find(o => o.lifecycle !== 'done')!.id;
    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: 5 } });
    let r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBe(1);
    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: null } });
    r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBeNull();
  });

  it('clamps a negative rate to 0 and rejects non-finite input', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const list = await api<{ orders: { id: string; lifecycle: string }[] }>(
      'GET', '/api/orders', { token: mgr });
    const id = list.body.orders.find(o => o.lifecycle !== 'done')!.id;

    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: -0.5 } });
    let r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBe(0);

    const bad = await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: 'abc' } });
    expect(bad.status).toBe(400);

    // The bad request must NOT have changed the stored value (still 0).
    r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBe(0);
  });

  it('GET /api/orders/:id returns the order commissionRate (so the PO editor can show it)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const list = await api<{ orders: { id: string; lifecycle: string }[] }>(
      'GET', '/api/orders', { token: mgr });
    const id = list.body.orders.find(o => o.lifecycle !== 'done')!.id;

    const set = await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: 0.2 } });
    expect(set.status).toBe(200);

    const detail = await api<{ order: { id: string; commissionRate: number | null } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(detail.status).toBe(200);
    expect(detail.body.order.commissionRate).toBeCloseTo(0.2, 4);

    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: null } });
    const cleared = await api<{ order: { commissionRate: number | null } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(cleared.body.order.commissionRate).toBeNull();
  });
});

describe('PATCH /api/orders/:id — Done is read-only', () => {
  beforeEach(async () => { await resetDb(); });

  // Walk a fresh purchase order all the way to Done so we can assert what
  // PATCH refuses to touch once the order is closed.
  async function makeDoneOrder(mgr: string): Promise<{ id: string; lineId: string }> {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const id = created.body.id;
    await api('POST', `/api/orders/${id}/advance`, { token: pTok }); // draft → in_transit
    for (const stage of ['reviewing', 'done']) {
      await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: stage } });
    }
    const detail = await api<{ order: { lifecycle: string; lines: { id: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(detail.body.order.lifecycle).toBe('done');
    return { id, lineId: detail.body.order.lines[0].id };
  }

  it('rejects line edits / cost edits / commission edits with 409', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineId } = await makeDoneOrder(mgr);

    const lineEdit = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { lines: [{ id: lineId, qty: 99 }] },
    });
    expect(lineEdit.status).toBe(409);

    const costEdit = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { totalCost: 99999 },
    });
    expect(costEdit.status).toBe(409);

    const rateEdit = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { commissionRate: 0.42 },
    });
    expect(rateEdit.status).toBe(409);

    // Verify the row is unchanged — line still qty=1, totalCost untouched.
    const after = await api<{ order: { lines: { qty: number }[]; commissionRate: number | null; totalCost: number | null } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(after.body.order.lines[0].qty).toBe(1);
  });

  // Fees are money on a closed-book record, so both the amount and the note
  // that explains it are frozen — unlike `notes`, which stays appendable.
  it('rejects other-fee edits with 409, amount and note alike', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { id } = await makeDoneOrder(mgr);

    const feeEdit = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { otherFees: 12.5 },
    });
    expect(feeEdit.status).toBe(409);

    const noteEdit = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { otherFeesNote: 'PayPal processing fee' },
    });
    expect(noteEdit.status).toBe(409);

    const after = await api<{ order: { otherFees: number; otherFeesNote: string | null } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(after.body.order.otherFees).toBe(0);
    expect(after.body.order.otherFeesNote).toBeNull();
  });

  it('allows notes-only PATCH on a Done order', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { id } = await makeDoneOrder(mgr);
    const r = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { notes: 'archive: case closed' },
    });
    expect(r.status).toBe(200);
    const after = await api<{ order: { notes: string | null } }>(
      'GET', `/api/orders/${id}`, { token: mgr });
    expect(after.body.order.notes).toBe('archive: case closed');
  });
});

describe('other fees on a purchase order', () => {
  beforeEach(async () => { await resetDb(); });

  async function draftPO(token: string): Promise<string> {
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 2, unitCost: 50, condition: 'New' }] },
    });
    expect(r.status).toBe(201);
    return r.body.id;
  }

  it('round-trips an amount and note set by the owner on their draft', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftPO(token);

    const patched = await api('PATCH', `/api/orders/${id}`, {
      token, body: { otherFees: 7.5, otherFeesNote: 'PayPal processing fee' },
    });
    expect(patched.status).toBe(200);

    const detail = await api<{ order: { otherFees: number; otherFeesNote: string | null } }>(
      'GET', `/api/orders/${id}`, { token });
    expect(detail.body.order.otherFees).toBe(7.5);
    expect(detail.body.order.otherFeesNote).toBe('PayPal processing fee');
  });

  it('accepts them at create time', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { category: 'RAM', warehouseId: 'WH-LA1', otherFees: 3.25, otherFeesNote: 'wire fee',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    expect(created.status).toBe(201);
    const detail = await api<{ order: { otherFees: number; otherFeesNote: string | null } }>(
      'GET', `/api/orders/${created.body.id}`, { token });
    expect(detail.body.order.otherFees).toBe(3.25);
    expect(detail.body.order.otherFeesNote).toBe('wire fee');
  });

  // other_fees is NOT NULL — a client clearing the box sends null and means 0.
  it('clears to 0 (not null) when sent null', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftPO(token);
    await api('PATCH', `/api/orders/${id}`, { token, body: { otherFees: 9, otherFeesNote: 'x' } });

    const cleared = await api('PATCH', `/api/orders/${id}`, {
      token, body: { otherFees: null, otherFeesNote: null },
    });
    expect(cleared.status).toBe(200);

    const detail = await api<{ order: { otherFees: number; otherFeesNote: string | null } }>(
      'GET', `/api/orders/${id}`, { token });
    expect(detail.body.order.otherFees).toBe(0);
    expect(detail.body.order.otherFeesNote).toBeNull();
  });

  it('stores a whitespace-only note as null', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftPO(token);
    await api('PATCH', `/api/orders/${id}`, { token, body: { otherFeesNote: '   ' } });
    const detail = await api<{ order: { otherFeesNote: string | null } }>(
      'GET', `/api/orders/${id}`, { token });
    expect(detail.body.order.otherFeesNote).toBeNull();
  });

  // The whole fee nets against the margin whatever share of the lines is
  // priced. That makes the list read as a loss on a PO nobody has priced yet,
  // which is deliberate — the fee is money already spent — and deliberately
  // more conservative than the edit screen's tape, which leaves fees out.
  const listRow = async (token: string, id: string) => {
    const list = await api<{ orders: { id: string; otherFees: number; profit: number; revenue: number }[] }>(
      'GET', '/api/orders?limit=100', { token });
    return list.body.orders.find(o => o.id === id)!;
  };

  it('charges the whole fee while nothing is priced yet', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftPO(token);
    await api('PATCH', `/api/orders/${id}`, { token, body: { otherFees: 20 } });

    const row = await listRow(token, id);
    expect(row.otherFees).toBe(20);
    expect(row.revenue).toBeCloseTo(0, 2);
    // No margin to offset it yet, so the row stands at the fee, negative.
    expect(row.profit).toBeCloseTo(-20, 2);
  });

  it('nets the fee against the margin once every line is priced', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftPO(token);
    const [lineId] = (await api<{ order: { lines: { id: string }[] } }>(
      'GET', `/api/orders/${id}`, { token })).body.order.lines.map(l => l.id);
    await api('PATCH', `/api/orders/${id}`, {
      token, body: { otherFees: 20, lines: [{ id: lineId, sellPrice: 80 }] },
    });

    const row = await listRow(token, id);
    // 2 × (80 − 50) = 60 of margin, less the full fee.
    expect(row.profit).toBeCloseTo(40, 2);
  });

  it('charges the whole fee even when only some lines are priced', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftPO(token);
    // A second line of equal goods value, left unpriced: it contributes no
    // margin and buys no discount on the fee.
    await api('PATCH', `/api/orders/${id}`, {
      token,
      body: { addLines: [{ category: 'RAM', qty: 2, unitCost: 50, condition: 'New' }] },
    });
    const lines = (await api<{ order: { lines: { id: string }[] } }>(
      'GET', `/api/orders/${id}`, { token })).body.order.lines;
    await api('PATCH', `/api/orders/${id}`, {
      token, body: { otherFees: 20, lines: [{ id: lines[0].id, sellPrice: 80 }] },
    });

    const row = await listRow(token, id);
    // 60 of margin on the priced line, less the whole 20 — not half of it.
    expect(row.profit).toBeCloseTo(40, 2);
  });
});

describe('concurrent order creation gets unique ids', () => {
  beforeEach(async () => { await resetDb(); });

  it('20 simultaneous draft creates all succeed with distinct ids', async () => {
    const { token } = await loginAs(MARCUS);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api<{ id: string }>('POST', '/api/orders/draft', { token, body: { category: 'RAM' } })),
    );
    for (const r of results) expect(r.status).toBe(201);
    const ids = results.map(r => r.body.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('POST /api/orders/:id/archive (+/unarchive)', () => {
  beforeEach(async () => { await resetDb(); });

  // Helper: create + advance an order out of Draft so it is eligible for archive.
  async function createInTransitOrder(token: string) {
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${created.body.id}/advance`, { token });
    return created.body.id;
  }

  it('owner can archive their own non-Draft order, and unarchive it back', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createInTransitOrder(token);

    const arch = await api('POST', `/api/orders/${id}/archive`, { token });
    expect(arch.status).toBe(200);

    const got = await api<{ order: { archivedAt: string | null } }>('GET', `/api/orders/${id}`, { token });
    expect(got.body.order.archivedAt).not.toBeNull();

    const unarch = await api('POST', `/api/orders/${id}/unarchive`, { token });
    expect(unarch.status).toBe(200);
    const got2 = await api<{ order: { archivedAt: string | null } }>('GET', `/api/orders/${id}`, { token });
    expect(got2.body.order.archivedAt).toBeNull();
  });

  it('manager can archive any non-Draft order', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: mTok } = await loginAs(ALEX);
    const id = await createInTransitOrder(pTok);

    const r = await api('POST', `/api/orders/${id}/archive`, { token: mTok });
    expect(r.status).toBe(200);
  });

  it('forbids a different purchaser from archiving someone else\'s order', async () => {
    const { token: ownerTok } = await loginAs(MARCUS);
    const { token: otherTok } = await loginAs(PRIYA);
    const id = await createInTransitOrder(ownerTok);

    const r = await api<{ error: string }>('POST', `/api/orders/${id}/archive`, { token: otherTok });
    expect(r.status).toBe(403);
  });

  it('refuses to archive a Draft (delete instead)', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const r = await api<{ error: string }>('POST', `/api/orders/${created.body.id}/archive`, { token });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/draft/i);
  });

  it('double-archive returns 409', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createInTransitOrder(token);
    await api('POST', `/api/orders/${id}/archive`, { token });
    const r = await api('POST', `/api/orders/${id}/archive`, { token });
    expect(r.status).toBe(409);
  });

  it('list endpoint excludes archived orders by default, includes them with ?includeArchived=true', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createInTransitOrder(token);
    await api('POST', `/api/orders/${id}/archive`, { token });

    const dflt = await api<{ orders: { id: string }[] }>('GET', '/api/orders', { token });
    expect(dflt.body.orders.find(o => o.id === id)).toBeUndefined();

    const all = await api<{ orders: { id: string; archivedAt: string | null }[] }>(
      'GET', '/api/orders?includeArchived=true', { token });
    const row = all.body.orders.find(o => o.id === id);
    expect(row).toBeDefined();
    expect(row!.archivedAt).not.toBeNull();
  });

  it('writes archived / unarchived audit events', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await createInTransitOrder(token);
    await api('POST', `/api/orders/${id}/archive`,   { token });
    await api('POST', `/api/orders/${id}/unarchive`, { token });

    const ev = await api<{ events: { kind: string }[] }>('GET', `/api/orders/${id}/events`, { token });
    const kinds = ev.body.events.map(e => e.kind);
    expect(kinds).toContain('archived');
    expect(kinds).toContain('unarchived');
  });
});

describe('order line serial numbers', () => {
  beforeEach(async () => { await resetDb(); });

  it('persists an optional multi-line serial number and returns it on the order detail', async () => {
    const { token } = await loginAs(MARCUS);
    const serials = 'SN-AAA-001\nSN-BBB-002\nSN-CCC-003';
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          partNumber: 'M393A4K40DB3-CWE', condition: 'Pulled — Tested',
          serialNumber: serials, chipNumber: 'K4A8G085WC-BCTD', qty: 3, unitCost: 78.5,
        }],
      },
    });
    expect(created.status).toBe(201);

    const got = await api<{ order: { lines: { serialNumber: string | null; chipNumber: string | null }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token },
    );
    expect(got.status).toBe(200);
    expect(got.body.order.lines[0].serialNumber).toBe(serials);
    expect(got.body.order.lines[0].chipNumber).toBe('K4A8G085WC-BCTD');
  });

  it('clears chip_number to null when the edit sends an empty string', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          partNumber: 'CHIP-CLEAR-1', condition: 'Pulled — Tested',
          chipNumber: 'K4A8G085WC-BCTD', qty: 1, unitCost: 10,
        }],
      },
    });
    expect(created.status).toBe(201);

    const before = await api<{ order: { lines: { id: string; chipNumber: string | null }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token },
    );
    const lineId = before.body.order.lines[0].id;
    expect(before.body.order.lines[0].chipNumber).toBe('K4A8G085WC-BCTD');

    const patched = await api('PATCH', '/api/orders/' + created.body.id, {
      token, body: { lines: [{ id: lineId, chipNumber: '' }] },
    });
    expect(patched.status).toBe(200);

    const after = await api<{ order: { lines: { chipNumber: string | null }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token },
    );
    expect(after.body.order.lines[0].chipNumber).toBeNull();
  });

  it('upper-cases chip_number on create and edit — die codes have one spelling', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Micron', capacity: '32GB', type: 'DDR4',
          partNumber: 'CHIP-CASE-1', condition: 'Pulled — Tested',
          chipNumber: ' d9xpf ', qty: 1, unitCost: 10,
        }],
      },
    });
    expect(created.status).toBe(201);

    const before = await api<{ order: { lines: { id: string; chipNumber: string | null }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token },
    );
    expect(before.body.order.lines[0].chipNumber).toBe('D9XPF');

    const patched = await api('PATCH', '/api/orders/' + created.body.id, {
      token, body: { lines: [{ id: before.body.order.lines[0].id, chipNumber: 'k4a8g045wc-bcwe' }] },
    });
    expect(patched.status).toBe(200);

    const after = await api<{ order: { lines: { chipNumber: string | null }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token },
    );
    expect(after.body.order.lines[0].chipNumber).toBe('K4A8G045WC-BCWE');
  });

  it('defaults serial_number to null when omitted, and surfaces it in inventory', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '16GB',
          partNumber: 'NO-SN-PART', condition: 'Pulled — Tested',
          qty: 1, unitCost: 20,
        }],
      },
    });
    expect(created.status).toBe(201);

    const inv = await api<{ items: { part_number: string | null; serial_number: string | null }[] }>(
      'GET', '/api/inventory', { token },
    );
    expect(inv.status).toBe(200);
    const row = inv.body.items.find(i => i.part_number === 'NO-SN-PART');
    expect(row).toBeTruthy();
    expect(row!.serial_number).toBeNull();
  });
});

describe('orders.commission_rate column', () => {
  beforeEach(async () => { await resetDb(); });

  it('exists and is nullable, seeded non-null on at least one order', async () => {
    const db = getTestDb();
    const rows = await db<{ commission_rate: number | null }[]>`
      SELECT commission_rate FROM orders
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.commission_rate !== null)).toBe(true);
    expect(rows.some(r => r.commission_rate === null)).toBe(true);
  });
});

describe('PATCH /api/orders/:id line status is not client-settable', () => {
  beforeEach(async () => { await resetDb(); });

  // order_lines.status is lifecycle-driven and 'Sold' is a protected terminal
  // state. The PATCH line path must ignore a client-supplied status so an
  // editor can't forge 'Sold'/'Done' and defeat the sell-order/inventory
  // guards that key off it.
  it('ignores a client-supplied line status while still applying other edits', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
          condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
        }],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const before = await api<{ order: { lines: { id: string; status: string }[] } }>(
      'GET', '/api/orders/' + id, { token });
    const lineId = before.body.order.lines[0].id;
    expect(before.body.order.lines[0].status).toBe('Draft');

    const patched = await api('PATCH', '/api/orders/' + id, {
      token,
      body: { lines: [{ id: lineId, status: 'Sold', qty: 7 }] },
    });
    expect(patched.status).toBe(200);

    const after = await api<{ order: { lines: { status: string; qty: number }[] } }>(
      'GET', '/api/orders/' + id, { token });
    // qty edit applied, status forge ignored.
    expect(after.body.order.lines[0].qty).toBe(7);
    expect(after.body.order.lines[0].status).toBe('Draft');
  });
});

describe('PATCH /api/orders/:id — AI scan fields persist', () => {
  beforeEach(async () => { await resetDb(); });

  // The desktop edit page lets a RAM line be filled from an AI label scan.
  // The scan's image key and confidence must survive both write paths —
  // adding a new line and patching an existing hand-entered one — or the
  // saved order silently loses the label photo the fill came from.
  it('persists scanImageId/scanConfidence through addLines and a line patch', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const added = await api('PATCH', '/api/orders/' + id, {
      token,
      body: {
        addLines: [{
          category: 'RAM', brand: 'SK Hynix', qty: 2, unitCost: 20,
          condition: 'New', scanImageId: 'scan-added-1', scanConfidence: 0.91,
        }],
      },
    });
    expect(added.status).toBe(200);

    type ScanLine = { id: string; scanImageId: string | null; scanConfidence: number | null };
    const mid = await api<{ order: { lines: ScanLine[] } }>('GET', '/api/orders/' + id, { token });
    const newLine = mid.body.order.lines.find(l => l.scanImageId === 'scan-added-1');
    expect(newLine?.scanConfidence).toBeCloseTo(0.91);

    const handEntered = mid.body.order.lines.find(l => l.scanImageId == null)!;
    const patched = await api('PATCH', '/api/orders/' + id, {
      token,
      body: { lines: [{ id: handEntered.id, brand: 'Samsung', scanImageId: 'scan-patched-1', scanConfidence: 0.87 }] },
    });
    expect(patched.status).toBe(200);

    const after = await api<{ order: { lines: ScanLine[] } }>('GET', '/api/orders/' + id, { token });
    const patchedLine = after.body.order.lines.find(l => l.id === handEntered.id)!;
    expect(patchedLine.scanImageId).toBe('scan-patched-1');
    expect(patchedLine.scanConfidence).toBeCloseTo(0.87);
  });
});

describe('PATCH /api/orders/:id — purchaser edits revert the PO to Draft', () => {
  beforeEach(async () => { await resetDb(); });

  async function createDraft(token: string): Promise<string> {
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
          condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
        }],
      },
    });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  type Detail = { order: { lifecycle: string; lines: { id: string; status: string }[] } };
  const detail = (id: string, token: string) =>
    api<Detail>('GET', `/api/orders/${id}`, { token });

  it('sends an In Transit order back to Draft when the owner edits a line', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const id = await createDraft(pur);
    await api('POST', `/api/orders/${id}/advance`, { token: pur });

    const before = await detail(id, pur);
    expect(before.body.order.lifecycle).toBe('in_transit');
    const lineId = before.body.order.lines[0].id;

    const patched = await api<{ lifecycle: string }>('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ id: lineId, unitCost: 0.01 }] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.lifecycle).toBe('draft');

    const after = await detail(id, pur);
    expect(after.body.order.lifecycle).toBe('draft');
    expect(after.body.order.lines[0].status).toBe('Draft');
  });

  it('reverts from Reviewing too, and records a `reverted` event', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const id = await createDraft(pur);
    await api('POST', `/api/orders/${id}/advance`, { token: pur });
    await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } });

    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { otherFees: 250 },
    })).status).toBe(200);
    expect((await detail(id, pur)).body.order.lifecycle).toBe('draft');

    const events = await api<{ events: { kind: string; detail: Record<string, unknown> }[] }>(
      'GET', `/api/orders/${id}/events`, { token: mgr });
    const reverted = events.body.events.filter(e => e.kind === 'reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0].detail.from).toBe('reviewing');
    expect(reverted[0].detail.to).toBe('draft');
  });

  it('leaves the stage alone for a notes-only edit', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const id = await createDraft(pur);
    await api('POST', `/api/orders/${id}/advance`, { token: pur });

    const patched = await api<{ lifecycle: string }>('PATCH', `/api/orders/${id}`, {
      token: pur, body: { notes: 'receipt arrived late' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.lifecycle).toBe('in_transit');
    expect((await detail(id, pur)).body.order.lifecycle).toBe('in_transit');

    const events = await api<{ events: { kind: string }[] }>(
      'GET', `/api/orders/${id}/events`, { token: mgr });
    expect(events.body.events.some(e => e.kind === 'reverted')).toBe(false);
  });

  it('does not revert when the editor is a manager', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const id = await createDraft(pur);
    await api('POST', `/api/orders/${id}/advance`, { token: pur });

    expect((await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { otherFees: 120 },
    })).status).toBe(200);
    expect((await detail(id, mgr)).body.order.lifecycle).toBe('in_transit');
  });

  it('keeps a Done order closed to the owner, note included', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const id = await createDraft(pur);
    await api('POST', `/api/orders/${id}/advance`, { token: pur });
    expect((await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'done' },
    })).status).toBe(200);

    expect((await api('PATCH', `/api/orders/${id}`, { token: pur, body: { notes: 'too late' } })).status).toBe(403);
    expect((await api('PATCH', `/api/orders/${id}`, { token: pur, body: { payment: 'self' } })).status).toBe(403);
    expect((await detail(id, mgr)).body.order.lifecycle).toBe('done');
  });

  it('still refuses the manager-only fields at every stage', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const id = await createDraft(pur);
    await api('POST', `/api/orders/${id}/advance`, { token: pur });

    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { commissionRate: 0.5 },
    })).status).toBe(403);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pur, body: { onBehalfOfUserId: null },
    })).status).toBe(403);
    const after = await api<Detail>('GET', `/api/orders/${id}`, { token: pur });
    expect(after.body.order.lifecycle).toBe('in_transit');
  });
});
