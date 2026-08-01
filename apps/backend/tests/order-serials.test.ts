import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { parseSerials, serialIssue } from '@recycle-erp/shared';

// Serial rules: DDR5 RAM lines must carry serial numbers, and any entered
// serials (any category) must match the line qty. Validated client-side for
// the dialog UX and re-enforced here at the API boundary.

type RamLineOpts = {
  generation?: string;
  serialNumber?: string | null;
  qty?: number;
  partNumber?: string;
};

function ramLine(opts: RamLineOpts = {}) {
  return {
    category: 'RAM',
    brand: 'Samsung',
    capacity: '32GB',
    generation: opts.generation ?? 'DDR4',
    type: 'Server',
    classification: 'RDIMM',
    rank: '2Rx4',
    speed: '3200',
    partNumber: opts.partNumber ?? 'SER-TEST-1',
    condition: 'Pulled — Tested',
    qty: opts.qty ?? 2,
    unitCost: 50,
    ...(opts.serialNumber !== undefined ? { serialNumber: opts.serialNumber } : {}),
  };
}

async function createPo(token: string, lines: unknown[]) {
  return api<{ id: string; error?: string }>('POST', '/api/orders', {
    token, body: { category: 'RAM', lines },
  });
}

describe('serialIssue (shared validator)', () => {
  it('flags a DDR5 RAM line without serials', () => {
    expect(serialIssue({ category: 'RAM', generation: 'DDR5', qty: 2, serialNumber: null }))
      .toEqual({ kind: 'ddr5Required' });
    expect(serialIssue({ category: 'RAM', generation: ' ddr5 ', qty: 2, serialNumber: '' }))
      .toEqual({ kind: 'ddr5Required' });
  });

  it('passes a DDR5 line whose serial count matches qty', () => {
    expect(serialIssue({ category: 'RAM', generation: 'DDR5', qty: 2, serialNumber: 'A\nB' }))
      .toBeNull();
  });

  it('does not require serials below DDR5 or outside RAM', () => {
    expect(serialIssue({ category: 'RAM', generation: 'DDR4', qty: 2, serialNumber: null }))
      .toBeNull();
    expect(serialIssue({ category: 'SSD', generation: 'DDR5', qty: 2, serialNumber: null }))
      .toBeNull();
  });

  it('flags a count mismatch for any category once serials are entered', () => {
    expect(serialIssue({ category: 'SSD', qty: 2, serialNumber: 'A,B,C' }))
      .toEqual({ kind: 'countMismatch', count: 3, qty: 2 });
  });

  it('parses newline/comma/semicolon-separated serials and drops blanks', () => {
    expect(parseSerials('A\nB, C;D\n\n ,')).toEqual(['A', 'B', 'C', 'D']);
    expect(serialIssue({ category: 'RAM', generation: 'DDR5', qty: 4, serialNumber: 'A\nB, C;D' }))
      .toBeNull();
  });
});

describe('POST /api/orders — serial rules', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects a DDR5 RAM line without serial numbers', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await createPo(token, [ramLine({ generation: 'DDR5' })]);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('DDR5');
    expect(r.body.error).toContain('line 1');
  });

  it('accepts a DDR5 line whose serial count matches qty and persists it', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await createPo(token, [ramLine({ generation: 'DDR5', serialNumber: 'SN-D5-1\nSN-D5-2', qty: 2 })]);
    expect(r.status).toBe(201);
    const got = await api<{ order: { lines: { serialNumber: string | null }[] } }>(
      'GET', '/api/orders/' + r.body.id, { token });
    expect(got.body.order.lines[0].serialNumber).toBe('SN-D5-1\nSN-D5-2');
  });

  it('rejects any line whose serial count differs from qty', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await createPo(token, [ramLine({ serialNumber: 'A,B,C', qty: 2 })]);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('serial number count (3)');
    expect(r.body.error).toContain('qty (2)');
  });

  it('still accepts serial-less non-DDR5 lines', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await createPo(token, [ramLine()]);
    expect(r.status).toBe(201);
  });
});

describe('PATCH /api/orders/:id — serial rules', () => {
  beforeEach(async () => { await resetDb(); });

  async function draftPo(token: string) {
    const r = await createPo(token, [ramLine({ qty: 3, partNumber: 'SER-BASE-1' })]);
    expect(r.status).toBe(201);
    const got = await api<{ order: { lines: { id: string }[] } }>(
      'GET', '/api/orders/' + r.body.id, { token });
    return { orderId: r.body.id, lineId: got.body.order.lines[0].id };
  }

  it('rejects addLines carrying a DDR5 line without serials', async () => {
    const { token } = await loginAs(MARCUS);
    const { orderId } = await draftPo(token);
    const r = await api<{ error?: string }>('PATCH', `/api/orders/${orderId}`, {
      token, body: { addLines: [ramLine({ generation: 'DDR5', partNumber: 'SER-ADD-1' })] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('DDR5');
  });

  it('accepts addLines when DDR5 serials match qty', async () => {
    const { token } = await loginAs(MARCUS);
    const { orderId } = await draftPo(token);
    const r = await api('PATCH', `/api/orders/${orderId}`, {
      token,
      body: { addLines: [ramLine({ generation: 'DDR5', serialNumber: 'X1;X2', qty: 2, partNumber: 'SER-ADD-2' })] },
    });
    expect(r.status).toBe(200);
  });

  it('rejects a line patch whose serials no longer match qty, leaving the row unchanged', async () => {
    const { token } = await loginAs(MARCUS);
    const { orderId, lineId } = await draftPo(token);
    const r = await api<{ error?: string }>('PATCH', `/api/orders/${orderId}`, {
      token, body: { lines: [{ id: lineId, serialNumber: 'ONLY-ONE' }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('count (1)');
    const sql = getTestDb();
    const [row] = await sql`SELECT serial_number FROM order_lines WHERE id = ${lineId}`;
    expect(row.serial_number).toBeNull();
  });

  it('validates the merged row when only qty changes', async () => {
    const { token } = await loginAs(MARCUS);
    const { orderId, lineId } = await draftPo(token);
    const ok = await api('PATCH', `/api/orders/${orderId}`, {
      token, body: { lines: [{ id: lineId, serialNumber: 'S1\nS2\nS3' }] },
    });
    expect(ok.status).toBe(200);
    const r = await api<{ error?: string }>('PATCH', `/api/orders/${orderId}`, {
      token, body: { lines: [{ id: lineId, qty: 2 }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('qty (2)');
  });

  it('leaves legacy serial-less DDR5 rows editable while serial fields stay untouched', async () => {
    const { token } = await loginAs(MARCUS);
    const { lineId, orderId } = await draftPo(token);
    // Simulate a row that predates the rules: DDR5, no serials.
    const sql = getTestDb();
    await sql`UPDATE order_lines SET generation = 'DDR5', serial_number = NULL WHERE id = ${lineId}`;

    // Price-only edit (the edit form echoes current serial/qty/generation
    // back): allowed — nothing serial-relevant changes.
    const priceOnly = await api('PATCH', `/api/orders/${orderId}`, {
      token,
      body: { lines: [{ id: lineId, sellPrice: 99, qty: 3, generation: 'DDR5', serialNumber: null }] },
    });
    expect(priceOnly.status).toBe(200);

    // Changing qty on the same legacy row forces the serial backfill.
    const qtyEdit = await api<{ error?: string }>('PATCH', `/api/orders/${orderId}`, {
      token, body: { lines: [{ id: lineId, qty: 5 }] },
    });
    expect(qtyEdit.status).toBe(400);
    expect(qtyEdit.body.error).toContain('DDR5');
  });
});

describe('inventory search by serial number', () => {
  beforeEach(async () => { await resetDb(); });

  const SERIAL = 'ZZSERIALZZ-77401';

  async function seedLine(token: string) {
    const r = await createPo(token, [
      ramLine({ serialNumber: `${SERIAL}\nOTHER-SN-2`, qty: 2, partNumber: 'SER-FIND-1' }),
    ]);
    expect(r.status).toBe(201);
  }

  it('finds the owning line via GET /api/inventory?q=<serial>', async () => {
    const { token } = await loginAs(ALEX);
    await seedLine(token);
    const r = await api<{ items: { serial_number: string | null }[] }>(
      'GET', `/api/inventory?q=${encodeURIComponent(SERIAL.toLowerCase())}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);
    expect(r.body.items[0].serial_number).toContain(SERIAL);
  });

  it('finds the owning product group via GET /api/inventory/products?q=<serial>', async () => {
    const { token } = await loginAs(ALEX);
    await seedLine(token);
    const r = await api<{ products: { part_number: string | null }[] }>(
      'GET', `/api/inventory/products?q=${encodeURIComponent(SERIAL)}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(1);
    expect(r.body.products[0].part_number).toBe('SER-FIND-1');
  });

  it('finds the line events via GET /api/inventory/events/all?q=<serial>', async () => {
    const { token } = await loginAs(ALEX);
    await seedLine(token);
    // Generate an inventory event on the line (condition edit → 'edited').
    const list = await api<{ items: { id: string }[] }>('GET', '/api/inventory', { token });
    const p = await api('PATCH', `/api/inventory/${list.body.items[0].id}`, {
      token, body: { condition: 'Pulled — Untested' },
    });
    expect(p.status).toBe(200);
    const r = await api<{ events: { line_id: string }[] }>(
      'GET', `/api/inventory/events/all?q=${encodeURIComponent(SERIAL)}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThan(0);
    const miss = await api<{ events: unknown[] }>(
      'GET', '/api/inventory/events/all?q=no-such-serial-xyz', { token });
    expect(miss.body.events.length).toBe(0);
  });
});
