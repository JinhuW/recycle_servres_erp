import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Label = { id: string; name: string; active: boolean; uses: number };

// An Other line with a label, ready to POST.
const otherLine = (itemLabel: string | null, over: Record<string, unknown> = {}) => ({
  category: 'Other',
  description: 'Xeon Gold 6248',
  ...(itemLabel === null ? {} : { itemLabel }),
  condition: 'Pulled — Tested',
  qty: 2,
  unitCost: 120,
  ...over,
});

const createOther = (token: string, line: Record<string, unknown>) =>
  api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'Other', warehouseId: 'WH-LA1', payment: 'company', lines: [line] },
  });

describe('item labels', () => {
  beforeEach(async () => { await resetDb(); });

  it('ships the seeded vocabulary through /api/lookups', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/lookups', { token });
    expect(r.status).toBe(200);
    expect(r.body.itemLabels).toBeInstanceOf(Array);
    expect(r.body.itemLabels.map((l: { name: string }) => l.name)).toContain('CPU');
  });

  it('lets a purchaser create a label inline', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string; name: string }>('POST', '/api/item-labels', {
      token, body: { name: 'Riser card' },
    });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('Riser card');

    const lookups = await api('GET', '/api/lookups', { token });
    expect(lookups.body.itemLabels.map((l: { name: string }) => l.name)).toContain('Riser card');
  });

  it('dedupes case-insensitively instead of minting a twin', async () => {
    const { token } = await loginAs(MARCUS);
    const first = await api<{ id: string; name: string }>('POST', '/api/item-labels', {
      token, body: { name: 'Backplane' },
    });
    const again = await api<{ id: string; name: string }>('POST', '/api/item-labels', {
      token, body: { name: '  bAcKpLaNe  ' },
    });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    // The original casing wins — the second caller does not get to restyle it.
    expect(again.body.name).toBe('Backplane');
  });

  it('rejects a blank or over-long name', async () => {
    const { token } = await loginAs(MARCUS);
    expect((await api('POST', '/api/item-labels', { token, body: { name: '   ' } })).status).toBe(400);
    expect((await api('POST', '/api/item-labels', { token, body: { name: 'x'.repeat(41) } })).status).toBe(400);
  });

  it('requires an item label on an Other line', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await createOther(token, otherLine(null));
    expect(r.status).toBe(400);

    const ok = await createOther(token, otherLine('CPU'));
    expect(ok.status).toBe(201);
  });

  it('does not require one on a spec-carrying category', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/orders', {
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
    expect(r.status).toBe(201);
  });

  it('round-trips the label on the order detail', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await createOther(token, otherLine('CPU'));
    const got = await api<{ order: { lines: { itemLabel: string }[] } }>(
      'GET', `/api/orders/${created.body.id}`, { token },
    );
    expect(got.body.order.lines[0].itemLabel).toBe('CPU');
  });

  it('rejects a PATCH that blanks the label on an Other line', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await createOther(token, otherLine('CPU'));
    const got = await api<{ order: { lines: { id: string }[] } }>(
      'GET', `/api/orders/${created.body.id}`, { token },
    );
    const lineId = got.body.order.lines[0].id;

    const blanked = await api('PATCH', `/api/orders/${created.body.id}`, {
      token, body: { lines: [{ id: lineId, itemLabel: '  ' }] },
    });
    expect(blanked.status).toBe(400);

    const changed = await api('PATCH', `/api/orders/${created.body.id}`, {
      token, body: { lines: [{ id: lineId, itemLabel: 'GPU' }] },
    });
    expect(changed.status).toBe(200);
  });

  it('leaves a patch that never mentions the label alone', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await createOther(token, otherLine('CPU'));
    const got = await api<{ order: { lines: { id: string }[] } }>(
      'GET', `/api/orders/${created.body.id}`, { token },
    );
    const r = await api('PATCH', `/api/orders/${created.body.id}`, {
      token, body: { lines: [{ id: got.body.order.lines[0].id, qty: 3 }] },
    });
    expect(r.status).toBe(200);
  });

  it('propagates a manager rename onto the lines carrying the old name', async () => {
    const { token: purchaser } = await loginAs(MARCUS);
    const created = await createOther(purchaser, otherLine('CPU'));

    const { token: manager } = await loginAs(ALEX);
    const list = await api<{ items: Label[] }>('GET', '/api/item-labels', { token: manager });
    const cpu = list.body.items.find(l => l.name === 'CPU')!;
    expect(cpu.uses).toBe(1);

    const renamed = await api<Label>('PATCH', `/api/item-labels/${cpu.id}`, {
      token: manager, body: { name: 'Processor' },
    });
    expect(renamed.status).toBe(200);

    const got = await api<{ order: { lines: { itemLabel: string }[] } }>(
      'GET', `/api/orders/${created.body.id}`, { token: manager },
    );
    expect(got.body.order.lines[0].itemLabel).toBe('Processor');
  });

  it('refuses a rename that collides with an existing label', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: Label[] }>('GET', '/api/item-labels', { token });
    const cpu = list.body.items.find(l => l.name === 'CPU')!;
    const r = await api('PATCH', `/api/item-labels/${cpu.id}`, { token, body: { name: 'GPU' } });
    expect(r.status).toBe(409);
  });

  it('keeps rename and retire away from purchasers', async () => {
    const { token: manager } = await loginAs(ALEX);
    const list = await api<{ items: Label[] }>('GET', '/api/item-labels', { token: manager });
    const cpu = list.body.items.find(l => l.name === 'CPU')!;

    const { token: purchaser } = await loginAs(MARCUS);
    const r = await api('PATCH', `/api/item-labels/${cpu.id}`, {
      token: purchaser, body: { name: 'Processor' },
    });
    expect(r.status).toBe(403);
  });

  it('retires a label out of the picker without disturbing lines that use it', async () => {
    const { token: purchaser } = await loginAs(MARCUS);
    const created = await createOther(purchaser, otherLine('CPU'));

    const { token: manager } = await loginAs(ALEX);
    const list = await api<{ items: Label[] }>('GET', '/api/item-labels', { token: manager });
    const cpu = list.body.items.find(l => l.name === 'CPU')!;
    await api('PATCH', `/api/item-labels/${cpu.id}`, { token: manager, body: { active: false } });

    const lookups = await api('GET', '/api/lookups', { token: manager });
    expect(lookups.body.itemLabels.map((l: { name: string }) => l.name)).not.toContain('CPU');

    const got = await api<{ order: { lines: { itemLabel: string }[] } }>(
      'GET', `/api/orders/${created.body.id}`, { token: manager },
    );
    expect(got.body.order.lines[0].itemLabel).toBe('CPU');
  });

  it('filters inventory by label', async () => {
    const { token: purchaser } = await loginAs(MARCUS);
    await createOther(purchaser, otherLine('CPU'));
    await createOther(purchaser, otherLine('PSU', { description: 'Delta 1600W' }));

    const { token } = await loginAs(ALEX);
    const all = await api<{ items: unknown[] }>('GET', '/api/inventory', { token });
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);

    const psu = await api<{ items: { item_label: string }[] }>(
      'GET', '/api/inventory?category=Other&label=PSU', { token },
    );
    expect(psu.body.items.length).toBe(1);
    expect(psu.body.items[0].item_label).toBe('PSU');
  });

  it('records a label change in the order audit trail', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await createOther(token, otherLine('CPU'));
    const got = await api<{ order: { lines: { id: string }[] } }>(
      'GET', `/api/orders/${created.body.id}`, { token },
    );
    await api('PATCH', `/api/orders/${created.body.id}`, {
      token, body: { lines: [{ id: got.body.order.lines[0].id, itemLabel: 'GPU' }] },
    });

    const sql = getTestDb();
    const events = await sql<{ detail: { changes?: { field: string }[] } }[]>`
      SELECT detail FROM order_events WHERE order_id = ${created.body.id} AND kind = 'line_edited'
    `;
    const fields = events.flatMap(e => (e.detail.changes ?? []).map(ch => ch.field));
    expect(fields).toContain('item_label');
  });
});
