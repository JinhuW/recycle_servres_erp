import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type InvRow = { id: string; status: string; warehouse_id: string | null; qty: number };
const WAREHOUSES = ['WH-LA1', 'WH-DAL', 'WH-NJ2', 'WH-HK', 'WH-AMS'];

// Transfer one sellable line to a different warehouse, return its id + dest.
async function transferOne(token: string): Promise<{ id: string; from: string; to: string }> {
  const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
  const line = inv.body.items.find(
    (i) => (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id,
  );
  if (!line) throw new Error('no sellable line in seed');
  const to = WAREHOUSES.find((w) => w !== line.warehouse_id)!;
  const r = await api('POST', '/api/inventory/transfer', {
    token,
    body: { toWarehouseId: to, lines: [{ id: line.id, qty: line.qty }] },
  });
  expect(r.status).toBe(200);
  return { id: line.id, from: line.warehouse_id!, to };
}

describe('GET /api/inventory/transfers', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/inventory/transfers', { token });
    expect(r.status).toBe(403);
  });

  it('lists a transferred line with from→to enrichment', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const r = await api<{ items: { id: string; from_wh: string; to_wh: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(r.status).toBe(200);
    const row = r.body.items.find((i) => i.id === moved.id);
    expect(row).toBeDefined();
    expect(row!.from_wh).toBe(moved.from);
    expect(row!.to_wh).toBe(moved.to);
  });

  it('excludes In Transit lines that were never transferred (purchase-origin)', async () => {
    const { token } = await loginAs(ALEX);
    const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
    const purchaseInTransit = inv.body.items.find((i) => i.status === 'In Transit');
    expect(purchaseInTransit).toBeDefined(); // seed has In Transit purchase lines
    const r = await api<{ items: { id: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(r.body.items.some((i) => i.id === purchaseInTransit!.id)).toBe(false);
  });
});

describe('POST /api/inventory/receive', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/inventory/receive', { token, body: { ids: ['x'] } });
    expect(r.status).toBe(403);
  });

  it('400 when ids is empty', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/inventory/receive', { token, body: { ids: [] } });
    expect(r.status).toBe(400);
  });

  it('moves an in-transit line to Done and removes it from /transfers', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const recv = await api<{ ok: true; ids: string[] }>(
      'POST', '/api/inventory/receive', { token, body: { ids: [moved.id] } },
    );
    expect(recv.status).toBe(200);
    expect(recv.body.ids).toEqual([moved.id]);

    const after = await api<{ items: { id: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(after.body.items.some((i) => i.id === moved.id)).toBe(false);

    const inv = await api<{ items: { id: string; status: string }[] }>(
      'GET', '/api/inventory', { token },
    );
    expect(inv.body.items.find((i) => i.id === moved.id)!.status).toBe('Done');
  });

  it('rejects the whole batch if any line is not In Transit', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
    const notInTransit = inv.body.items.find(
      (i) => i.status === 'Done' || i.status === 'Reviewing',
    )!;
    const r = await api('POST', '/api/inventory/receive', {
      token, body: { ids: [moved.id, notInTransit.id] },
    });
    expect(r.status).toBe(400);
    const after = await api<{ items: { id: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(after.body.items.some((i) => i.id === moved.id)).toBe(true);
  });
});
