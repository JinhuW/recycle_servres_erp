import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// A PO may hold lines of several categories. `orders.category` is a
// denormalization of the lines — the sole category when they agree, 'Mixed'
// when they don't — so every path that writes lines has to re-derive it.

type OrderBody = { order: { category: string; categories: string[]; lines: Line[] } };
type Line = {
  id: string; category: string; brand: string | null; capacity: string | null;
  generation: string | null; interface: string | null; formFactor: string | null;
  rpm: number | null; health: number | null; partNumber: string | null;
  itemType: string | null; description: string | null; qty: number; serialNumber: string | null;
};

const get = async (token: string, id: string) =>
  (await api<OrderBody>('GET', '/api/orders/' + id, { token })).body.order;

const makePo = async (token: string, lines: Record<string, unknown>[]) => {
  const r = await api<{ id: string }>('POST', '/api/orders', { token, body: { lines } });
  expect(r.status).toBe(201);
  return r.body.id;
};

const RAM_LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'Server',
  classification: 'RDIMM', rank: '2Rx4', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
};
const SSD_LINE = {
  category: 'SSD', brand: 'Intel', capacity: '960GB', interface: 'SATA', formFactor: '2.5"',
  partNumber: 'SSDSC2KB960G8', condition: 'Pulled — Tested', qty: 2, unitCost: 71.66,
};

describe('derived order category', () => {
  beforeEach(async () => { await resetDb(); });

  it('re-derives when a line of a new category is appended', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    expect((await get(token, id)).category).toBe('RAM');

    const r = await api('PATCH', '/api/orders/' + id, { token, body: { addLines: [SSD_LINE] } });
    expect(r.status).toBe(200);

    const after = await get(token, id);
    expect(after.category).toBe('Mixed');
    expect(after.categories).toEqual(['RAM', 'SSD']);
  });

  it('collapses back to a single category when the odd line is removed', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE, SSD_LINE]);
    const before = await get(token, id);
    expect(before.category).toBe('Mixed');

    const ssdId = before.lines.find(l => l.category === 'SSD')!.id;
    const r = await api('PATCH', '/api/orders/' + id, { token, body: { removeLineIds: [ssdId] } });
    expect(r.status).toBe(200);

    const after = await get(token, id);
    expect(after.category).toBe('RAM');
    expect(after.categories).toEqual(['RAM']);
  });

  it('re-derives when a line is recategorised in place', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const lineId = (await get(token, id)).lines[0].id;

    const r = await api('PATCH', '/api/orders/' + id, {
      token,
      body: { lines: [{ id: lineId, category: 'SSD', interface: 'SATA' }] },
    });
    expect(r.status).toBe(200);

    const after = await get(token, id);
    expect(after.category).toBe('SSD');
    expect(after.lines[0].category).toBe('SSD');
  });

  it('leaves an empty draft alone rather than inventing a category', async () => {
    const { token } = await loginAs(MARCUS);
    const draft = await api<{ id: string }>('POST', '/api/orders/draft', { token, body: {} });
    expect(draft.status).toBe(201);
    const o = await get(token, draft.body.id);
    expect(o.categories).toEqual([]);
  });
});

describe('recategorising a line', () => {
  beforeEach(async () => { await resetDb(); });

  it('clears the old category’s spec fields and keeps the shared ones', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [{ ...RAM_LINE, serialNumber: '' }]);
    const lineId = (await get(token, id)).lines[0].id;

    await api('PATCH', '/api/orders/' + id, {
      token,
      body: { lines: [{ id: lineId, category: 'SSD', interface: 'NVMe', formFactor: 'M.2' }] },
    });

    const l = (await get(token, id)).lines[0];
    // Owned by RAM only — gone.
    expect(l.generation).toBeNull();
    // Owned by SSD — applied from the same patch.
    expect(l.interface).toBe('NVMe');
    expect(l.formFactor).toBe('M.2');
    // Shared by both, and category-agnostic — untouched.
    expect(l.brand).toBe('Samsung');
    expect(l.capacity).toBe('32GB');
    expect(l.qty).toBe(4);

    const db = getTestDb();
    const [row] = await db<{ classification: string | null; rank: string | null; speed: string | null; chip_number: string | null }[]>`
      SELECT classification, rank, speed, chip_number FROM order_lines WHERE id = ${lineId}::uuid
    `;
    expect(row.classification).toBeNull();
    expect(row.rank).toBeNull();
    expect(row.speed).toBeNull();
    expect(row.chip_number).toBeNull();
  });

  it('keeps a typed part number', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const lineId = (await get(token, id)).lines[0].id;

    await api('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: lineId, category: 'SSD', interface: 'SATA' }] },
    });
    expect((await get(token, id)).lines[0].partNumber).toBe('M393A4K40DB3-CWE');
  });

  it('never nulls a synthetic part number when the new category has no rule', async () => {
    const { token } = await loginAs(MARCUS);
    // A blank PN on a Mixed-brand SSD is synthesised as MIXED_<cap>_<iface>_<form>.
    // SSD is the only category with a synth rule today (SYNTH_PN_RULES), so a
    // switch to HDD has nothing to rebuild from. Inventory grouping and
    // reference pricing are both keyed on part_number, so the old value is kept
    // rather than cleared.
    const id = await makePo(token, [{
      category: 'SSD', brand: 'Mixed', capacity: '960GB', interface: 'SATA', formFactor: '2.5"',
      condition: 'Pulled — Tested', qty: 1, unitCost: 20,
    }]);
    const line = (await get(token, id)).lines[0];
    expect(line.partNumber).toBe('MIXED_960GB_SATA_2.5');

    await api('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: line.id, category: 'HDD', interface: 'SAS', formFactor: '3.5"' }] },
    });
    const after = (await get(token, id)).lines[0];
    expect(after.category).toBe('HDD');
    expect(after.partNumber).toBe('MIXED_960GB_SATA_2.5');
  });

  it('rejects a switch into Other without an item type', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const lineId = (await get(token, id)).lines[0].id;

    const r = await api<{ error: string }>('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: lineId, category: 'Other', description: 'A thing' }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/item type/i);
  });

  it('accepts a switch into Other that names the item type', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const lineId = (await get(token, id)).lines[0].id;

    const r = await api('PATCH', '/api/orders/' + id, {
      token,
      body: { lines: [{ id: lineId, category: 'Other', itemType: 'Riser card', description: 'Dell R740 riser' }] },
    });
    expect(r.status).toBe(200);
    const l = (await get(token, id)).lines[0];
    expect(l.category).toBe('Other');
    expect(l.itemType).toBe('Riser card');
    expect(l.brand).toBeNull();
  });

  it('relaxes the DDR5 serial rule once the line leaves RAM', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [{
      ...RAM_LINE, generation: 'DDR5', qty: 2, serialNumber: 'SN-1\nSN-2',
    }]);
    const lineId = (await get(token, id)).lines[0].id;

    // Same qty, no serials in the patch — as a DDR5 RAM line this would still
    // pass (serials are stored), but the point is the switch itself is allowed
    // and doesn't evaluate against a generation the line no longer has.
    const r = await api('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: lineId, category: 'SSD', interface: 'SATA', serialNumber: '' }] },
    });
    expect(r.status).toBe(200);
    expect((await get(token, id)).lines[0].generation).toBeNull();
  });

  it('records the switch in the change log', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const lineId = (await get(token, id)).lines[0].id;
    await api('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: lineId, category: 'SSD', interface: 'SATA' }] },
    });

    const ev = await api<{ events: { kind: string; detail: Record<string, unknown> }[] }>(
      'GET', `/api/orders/${id}/events`, { token },
    );
    const edited = ev.body.events.filter(e => e.kind === 'line_edited');
    const changes = edited.flatMap(e => (e.detail.changes ?? []) as { field: string; from: unknown; to: unknown }[]);
    expect(changes).toContainEqual(expect.objectContaining({ field: 'category', from: 'RAM', to: 'SSD' }));
  });
});

describe('per-line category validation', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects a disabled category on one line of a mixed create', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ error: string }>('POST', '/api/orders', {
      token,
      body: {
        lines: [RAM_LINE, { category: 'CPU', qty: 1, unitCost: 5, condition: 'New' }],
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/CPU/);
  });

  it('rejects a disabled category on PATCH addLines', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const r = await api<{ error: string }>('PATCH', '/api/orders/' + id, {
      token, body: { addLines: [{ category: 'CPU', qty: 1, unitCost: 5, condition: 'New' }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/CPU/);
  });

  // orders.category is a DERIVATION of the lines, so it is not a value a line
  // may inherit: 'Mixed' is not a row in the categories table, so a line filed
  // under it matches no category chip, exports to the wrong sheet, clears no
  // spec fields on a later switch, and skips the Other item-type rule.
  it('refuses to inherit the order category when the PO is Mixed', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE, SSD_LINE]);
    expect((await get(token, id)).category).toBe('Mixed');

    const r = await api<{ error: string }>('PATCH', '/api/orders/' + id, {
      token, body: { addLines: [{ qty: 1, unitCost: 5, condition: 'New' }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/category is required/);

    const after = await get(token, id);
    expect(after.categories).toEqual(['RAM', 'SSD']);
    expect(after.lines.map(l => l.category)).not.toContain('Mixed');
  });

  it('still inherits the order category when the PO holds only one', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const r = await api('PATCH', '/api/orders/' + id, {
      token, body: { addLines: [{ brand: 'Crucial', qty: 1, unitCost: 5, condition: 'New' }] },
    });
    expect(r.status).toBe(200);

    const after = await get(token, id);
    expect(after.category).toBe('RAM');
    expect(after.lines.map(l => l.category)).toEqual(['RAM', 'RAM']);
  });

  // The INSERT writes deriveCategory()'s answer directly; syncOrderCategory
  // corrects it a few statements later, so a per-line list read as 'Mixed' only
  // survives in the `created` audit event — and in whatever runs before the
  // sync next time someone reorders this block.
  it('files a multi-line single-category PO under that category from the first write', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [
      RAM_LINE,
      { ...RAM_LINE, partNumber: 'M393A4K40DB3-CWF' },
      { ...RAM_LINE, partNumber: 'M393A4K40DB3-CWG' },
    ]);
    const [created] = await getTestDb()<{ detail: { category: string } }[]>`
      SELECT detail FROM order_events WHERE order_id = ${id} AND kind = 'created'
    `;
    expect(created.detail.category).toBe('RAM');
    expect((await get(token, id)).category).toBe('RAM');
  });

  it('does not retro-block an edit to a line whose category is untouched', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE]);
    const lineId = (await get(token, id)).lines[0].id;

    const db = getTestDb();
    await db`UPDATE categories SET enabled = FALSE WHERE id = 'RAM'`;

    const r = await api('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: lineId, unitCost: 99 }] },
    });
    expect(r.status).toBe(200);
  });

  it('requires an item type only on the Other line of a mixed PO', async () => {
    const { token } = await loginAs(MARCUS);
    // A RAM line on a PO that also holds an Other line must not be item-type
    // checked — the old code keyed that rule off the ORDER's category.
    const r = await api('POST', '/api/orders', {
      token,
      body: {
        lines: [
          RAM_LINE,
          { category: 'Other', itemType: 'Riser card', description: 'Dell riser', qty: 1, unitCost: 5, condition: 'New' },
        ],
      },
    });
    expect(r.status).toBe(201);
  });
});

describe('GET /api/orders?category= matches the lines', () => {
  beforeEach(async () => { await resetDb(); });

  it('finds a mixed PO under every category it holds', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, [RAM_LINE, SSD_LINE]);

    for (const cat of ['RAM', 'SSD']) {
      const r = await api<{ orders: { id: string }[] }>(
        'GET', `/api/orders?category=${cat}&mine=true`, { token },
      );
      expect(r.body.orders.map(o => o.id), `missing under ?category=${cat}`).toContain(id);
    }
    const hdd = await api<{ orders: { id: string }[] }>('GET', '/api/orders?category=HDD&mine=true', { token });
    expect(hdd.body.orders.map(o => o.id)).not.toContain(id);
  });

  it('excludes an empty draft from every category', async () => {
    const { token } = await loginAs(MARCUS);
    const draft = await api<{ id: string }>('POST', '/api/orders/draft', { token, body: {} });

    for (const cat of ['RAM', 'SSD', 'HDD', 'Other']) {
      const r = await api<{ orders: { id: string }[] }>(
        'GET', `/api/orders?category=${cat}&mine=true`, { token },
      );
      expect(r.body.orders.map(o => o.id)).not.toContain(draft.body.id);
    }
  });
});
