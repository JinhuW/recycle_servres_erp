import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { expectSheetOrder, type SheetOrdered } from './helpers/inventory';

describe('GET /api/inventory — role-based field visibility', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager sees unit_cost / profit / margin', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: Record<string, unknown>[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    const item = r.body.items[0];
    expect(item).toBeDefined();
    expect(item).toHaveProperty('unit_cost');
    expect(typeof (item as { unit_cost: number }).unit_cost).toBe('number');
  });

  it('purchaser does NOT see unit_cost / profit / margin', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ items: Record<string, unknown>[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    const item = r.body.items[0];
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('unit_cost');
    expect(item).not.toHaveProperty('profit');
    expect(item).not.toHaveProperty('margin');
    // Sell price IS visible (it's the price the team is asking — not sensitive).
    expect(item).toHaveProperty('sell_price');
  });

  it('purchaser scoped to own lines only', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{ items: { user_id: string }[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    for (const it of r.body.items) expect(it.user_id).toBe(user.id);
  });
});

describe('GET /api/inventory — sold lots hidden by default', () => {
  beforeEach(async () => { await resetDb(); });

  // Flip a seeded line to the terminal Sold state without driving the whole
  // sell-order→Done flow — we're exercising the list filter, not the sale.
  async function markFirstLineSold(token: string): Promise<string> {
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    const list = await api<{ items: { id: string }[] }>('GET', '/api/inventory', { token });
    const id = list.body.items[0].id;
    await sql`UPDATE order_lines SET status = 'Sold' WHERE id = ${id}`;
    return id;
  }

  it('omits Sold lines from the default list', async () => {
    const { token } = await loginAs(ALEX);
    const soldId = await markFirstLineSold(token);
    const r = await api<{ items: { id: string }[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    expect(r.body.items.some(i => i.id === soldId)).toBe(false);
  });

  it('includeSold=1 brings Sold lines back', async () => {
    const { token } = await loginAs(ALEX);
    const soldId = await markFirstLineSold(token);
    const r = await api<{ items: { id: string; status: string }[] }>(
      'GET', '/api/inventory?includeSold=1', { token });
    expect(r.status).toBe(200);
    const row = r.body.items.find(i => i.id === soldId);
    expect(row?.status).toBe('Sold');
  });

  it('an explicit status=Sold filter overrides the default hide', async () => {
    const { token } = await loginAs(ALEX);
    const soldId = await markFirstLineSold(token);
    const r = await api<{ items: { id: string; status: string }[] }>(
      'GET', '/api/inventory?status=Sold', { token });
    expect(r.status).toBe(200);
    expect(r.body.items.some(i => i.id === soldId)).toBe(true);
    expect(r.body.items.every(i => i.status === 'Sold')).toBe(true);
  });
});

describe('low-margin notification', () => {
  beforeEach(async () => { await resetDb(); });

  it('fires when sell_price gives margin < 15%', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: { id: string; unit_cost: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    const target = list.body.items[0];
    const newPrice = +(target.unit_cost * 1.05).toFixed(2);

    const r = await api<{ warnings?: string[] }>('PATCH', `/api/inventory/${target.id}`, {
      token, body: { sellPrice: newPrice },
    });
    expect(r.status).toBe(200);
    expect(r.body.warnings ?? []).toContain('low_margin');
    const after = await api<{ items: { kind: string }[] }>('GET', '/api/notifications', { token });
    expect(after.body.items.some(i => i.kind === 'low_margin')).toBe(true);
  });

  it('honours a workspace-configured low_margin_floor', async () => {
    const { token } = await loginAs(ALEX);
    // Drop the floor to 0 — a thin 5% margin should no longer warn.
    const w = await api('PATCH', '/api/workspace', { token, body: { low_margin_floor: 0 } });
    expect(w.status).toBe(200);

    const list = await api<{ items: { id: string; unit_cost: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    const target = list.body.items[0];
    const newPrice = +(target.unit_cost * 1.05).toFixed(2);

    const r = await api<{ warnings?: string[] }>('PATCH', `/api/inventory/${target.id}`, {
      token, body: { sellPrice: newPrice },
    });
    expect(r.status).toBe(200);
    expect(r.body.warnings ?? []).not.toContain('low_margin');
  });
});

// A sell price of 0 means "nobody has priced this line", not "priced at
// nothing" — the same rule the PO drawer writes by (shared/sellPrice). This
// endpoint used to COALESCE it, which read 0 as "no change" and silently kept
// whatever price was already there.
describe('unpricing a line from the inventory editor', () => {
  beforeEach(async () => { await resetDb(); });

  const priced = async (token: string) => {
    const list = await api<{ items: { id: string; unit_cost: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    const target = list.body.items[0];
    const r = await api('PATCH', `/api/inventory/${target.id}`, {
      token, body: { sellPrice: +(target.unit_cost * 2).toFixed(2) },
    });
    expect(r.status).toBe(200);
    return target.id;
  };

  const storedPrice = async (id: string) => {
    const { getTestDb } = await import('./helpers/db');
    const [row] = await getTestDb()<{ sell_price: number | null }[]>`
      SELECT sell_price::float AS sell_price FROM order_lines WHERE id = ${id}::uuid
    `;
    return row.sell_price;
  };

  it('clears the stored price rather than keeping the old one', async () => {
    const { token } = await loginAs(ALEX);
    const id = await priced(token);
    expect(await storedPrice(id)).not.toBeNull();

    const r = await api('PATCH', `/api/inventory/${id}`, { token, body: { sellPrice: 0 } });
    expect(r.status).toBe(200);
    expect(await storedPrice(id)).toBeNull();
  });

  it('does not warn about margin on a line it just unpriced', async () => {
    const { token } = await loginAs(ALEX);
    const id = await priced(token);
    const r = await api<{ warnings?: string[] }>('PATCH', `/api/inventory/${id}`, {
      token, body: { sellPrice: 0 },
    });
    expect(r.body.warnings ?? []).toEqual([]);
  });
});

describe('audit log is append-only', () => {
  beforeEach(async () => { await resetDb(); });

  it('raw UPDATE on inventory_events is rejected', async () => {
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    let err: Error | null = null;
    try {
      await sql`UPDATE inventory_events SET detail = '{}'::jsonb WHERE id IN (SELECT id FROM inventory_events LIMIT 1)`;
    } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/append-only/i);
  });
});

describe('PATCH /api/inventory/:id — unit cost is manager-only', () => {
  beforeEach(async () => { await resetDb(); });

  // unit_cost feeds the commission math; an owner rewriting it on their own
  // (possibly already-sold) lines would inflate their commission retroactively.
  it('purchaser cannot rewrite unitCost on an own line; manager can', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const mine = await api<{ items: { id: string }[] }>('GET', '/api/inventory', { token: pur });
    const id = mine.body.items[0].id;

    const denied = await api('PATCH', `/api/inventory/${id}`, { token: pur, body: { unitCost: 0.01 } });
    expect(denied.status).toBe(403);

    const { token: mgr } = await loginAs(ALEX);
    const ok = await api('PATCH', `/api/inventory/${id}`, { token: mgr, body: { unitCost: 42 } });
    expect(ok.status).toBe(200);
  });
});

describe('PATCH /api/inventory/:id — spec fields', () => {
  beforeEach(async () => { await resetDb(); });

  async function firstRamLine(token: string): Promise<string> {
    const r = await api<{ items: { id: string; category: string }[] }>(
      'GET', '/api/inventory', { token },
    );
    const line = r.body.items.find(i => i.category === 'RAM');
    expect(line, 'seed has no RAM line').toBeDefined();
    return line!.id;
  }

  async function specOf(id: string) {
    const { getTestDb } = await import('./helpers/db');
    const rows = await getTestDb()<{ brand: string | null; capacity: string | null }[]>`
      SELECT brand, capacity FROM order_lines WHERE id = ${id}
    `;
    return rows[0];
  }

  it('manager edits brand + capacity and each change lands one audit event', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstRamLine(token);
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    const before = await specOf(id);

    const r = await api('PATCH', `/api/inventory/${id}`, {
      token, body: { brand: 'Micron', capacity: '64GB' },
    });
    expect(r.status).toBe(200);
    expect(await specOf(id)).toEqual({ brand: 'Micron', capacity: '64GB' });

    const events = await sql<{ detail: { field: string; from: string | null; to: string } }[]>`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${id} AND kind = 'edited'
      ORDER BY created_at
    `;
    const byField = new Map(events.map(e => [e.detail.field, e.detail]));
    expect(byField.get('brand')).toMatchObject({ from: before.brand, to: 'Micron' });
    expect(byField.get('capacity')).toMatchObject({ from: before.capacity, to: '64GB' });
  });

  it('an owner may correct specs on their own line; a stranger may not', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const mine = await api<{ items: { id: string }[] }>('GET', '/api/inventory', { token: pur });
    const ownId = mine.body.items[0].id;
    const ok = await api('PATCH', `/api/inventory/${ownId}`, { token: pur, body: { brand: 'Micron' } });
    expect(ok.status).toBe(200);

    // A line the purchaser does not own — the owner probe rejects before any write.
    const { token: mgr } = await loginAs(ALEX);
    const all = await api<{ items: { id: string; user_id: string }[] }>(
      'GET', '/api/inventory', { token: mgr },
    );
    const mineSet = new Set(mine.body.items.map(i => i.id));
    const foreign = all.body.items.find(i => !mineSet.has(i.id));
    expect(foreign, 'seed has no line owned by someone else').toBeDefined();
    const denied = await api('PATCH', `/api/inventory/${foreign!.id}`, {
      token: pur, body: { brand: 'Micron' },
    });
    expect(denied.status).toBe(403);
  });

  it('an explicit null clears a spec column', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstRamLine(token);
    const r = await api('PATCH', `/api/inventory/${id}`, { token, body: { brand: null } });
    expect(r.status).toBe(200);
    expect((await specOf(id)).brand).toBeNull();
  });

  // '' must land as NULL, not as an empty string: the brand facet matches on
  // equality and the top-brands rollup treats '' separately from NULL, so a
  // stored '' shows up as a ghost facet value.
  it('an empty string clears to NULL rather than storing an empty string', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstRamLine(token);
    const r = await api('PATCH', `/api/inventory/${id}`, { token, body: { brand: '' } });
    expect(r.status).toBe(200);
    expect((await specOf(id)).brand).toBeNull();
  });

  it('clearing an already-NULL spec writes no event', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstRamLine(token);
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    await sql`UPDATE order_lines SET brand = NULL WHERE id = ${id}`;
    const countBefore = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM inventory_events WHERE order_line_id = ${id}
    `;

    const r = await api('PATCH', `/api/inventory/${id}`, { token, body: { brand: '' } });
    expect(r.status).toBe(200);

    const countAfter = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM inventory_events WHERE order_line_id = ${id}
    `;
    expect(countAfter[0].n).toBe(countBefore[0].n);
  });

  // Spec corrections are not goods-touching, so the Done-PO lock (qty/unitCost)
  // must not catch them — fixing a mislabelled brand is exactly the post-Done
  // inventory workflow.
  it('a spec edit is allowed on a line whose PO is Done', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstRamLine(token);
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    await sql`
      UPDATE orders SET lifecycle = 'done'
      WHERE id = (SELECT order_id FROM order_lines WHERE id = ${id})
    `;
    const r = await api('PATCH', `/api/inventory/${id}`, { token, body: { brand: 'Micron' } });
    expect(r.status).toBe(200);
    expect((await specOf(id)).brand).toBe('Micron');
  });
});

describe('GET /api/inventory — row order', () => {
  beforeEach(async () => { await resetDb(); });

  it('ships the list in the workbook order — category, then brand, capacity, speed', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: SheetOrdered[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    expectSheetOrder(r.body.items);
  });

  it('orders a scoped purchaser list the same way', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ items: SheetOrdered[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    expectSheetOrder(r.body.items);
  });
});

// rpm and health became editable dropdowns, but their columns stayed on
// COALESCE — so the blank option could not clear them, and the timeline claimed
// it had. The two halves are one bug: the write silently did nothing and the
// audit said otherwise.
describe('PATCH /api/inventory/:id — clearing a numeric spec', () => {
  beforeEach(async () => { await resetDb(); });

  async function firstHddLine(token: string): Promise<string> {
    const r = await api<{ items: { id: string; category: string }[] }>(
      'GET', '/api/inventory', { token });
    const line = r.body.items.find(i => i.category === 'HDD') ?? r.body.items[0];
    expect(line, 'seed has no inventory line').toBeDefined();
    return line!.id;
  }

  it('clears rpm and logs exactly one true event', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstHddLine(token);
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    await sql`UPDATE order_lines SET rpm = 7200 WHERE id = ${id}`;
    const before = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM inventory_events WHERE order_line_id = ${id}`;

    const r = await api('PATCH', `/api/inventory/${id}`, { token, body: { rpm: null } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const [row] = await sql<{ rpm: number | null }[]>`
      SELECT rpm FROM order_lines WHERE id = ${id}`;
    expect(row.rpm).toBeNull();

    const after = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM inventory_events WHERE order_line_id = ${id}`;
    expect(after[0].n).toBe(before[0].n + 1);
  });

  it('clears health the same way', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstHddLine(token);
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    await sql`UPDATE order_lines SET health = 98 WHERE id = ${id}`;

    const r = await api('PATCH', `/api/inventory/${id}`, { token, body: { health: null } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const [row] = await sql<{ health: number | null }[]>`
      SELECT health FROM order_lines WHERE id = ${id}`;
    expect(row.health).toBeNull();
  });

  it('leaves rpm alone when the field is omitted, and writes no event', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstHddLine(token);
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    await sql`UPDATE order_lines SET rpm = 7200 WHERE id = ${id}`;
    const before = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM inventory_events WHERE order_line_id = ${id}`;

    await api('PATCH', `/api/inventory/${id}`, { token, body: { condition: 'Used' } });

    const [row] = await sql<{ rpm: number | null }[]>`
      SELECT rpm FROM order_lines WHERE id = ${id}`;
    expect(row.rpm).toBe(7200);
    const after = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM inventory_events WHERE order_line_id = ${id}`;
    // condition may or may not have changed; rpm must contribute nothing.
    expect(after[0].n).toBeLessThanOrEqual(before[0].n + 1);
  });
});
