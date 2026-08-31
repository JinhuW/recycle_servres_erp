import { expect } from 'vitest';
import { categoryRank } from '@recycle-erp/shared';
import { compareSpecValue } from '../../src/lib/categoryColumns';
import { api } from './app';

export type SellableLine = { id: string; qty: number; unit_cost: number; sell_price: number };

export type SheetOrdered = {
  category: string; brand?: string | null; capacity?: string | null; speed?: string | null;
};

// Both inventory screens read like the workbook: category rank first, then
// brand, capacity, speed. Asserts the ordering PROPERTY, never literal values —
// seed.mjs picks brands and capacities at random, so pinned strings are flaky.
export function expectSheetOrder(rows: readonly SheetOrdered[]): void {
  expect(rows.length).toBeGreaterThan(1);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    let d = categoryRank(a.category) - categoryRank(b.category);
    for (const k of ['brand', 'capacity', 'speed'] as const) {
      if (d !== 0) break;
      d = compareSpecValue(String(a[k] ?? ''), String(b[k] ?? ''));
    }
    expect(d).toBeLessThanOrEqual(0);
  }
}

// Find a Reviewing inventory line that is sellable AND not already committed to
// an open (non-Done) sell order. The seed legitimately attaches its first 36
// sellable lines to seeded sell orders, and the one-active-sell-order-per-line
// invariant rejects a second open order on the same line — so tests that build
// a fresh sell order must start from a genuinely free line.
//
// `exclude` lets a caller ask for a SECOND distinct free line within the same
// test, before any order has been posted (which is otherwise what marks a
// line "taken" — a second call with no order in between would just return the
// same line again).
export async function freeSellableLine(
  token: string, minQty = 1, exclude: ReadonlySet<string> = new Set(),
): Promise<SellableLine> {
  const r = await api<{ items: Array<{ id: string; status: string; qty: number; unit_cost: number; sell_price: number | null }> }>(
    'GET', '/api/inventory?status=Reviewing', { token });
  const candidates = r.body.items.filter(i =>
    i.sell_price != null && i.qty >= minQty && !exclude.has(i.id));
  for (const c of candidates) {
    const so = await api<{ items: { status: string }[] }>(
      'GET', `/api/inventory/${c.id}/sell-orders`, { token });
    const onOpenOrder = so.body.items.some(s => s.status !== 'Done');
    if (!onOpenOrder) {
      return { id: c.id, qty: c.qty, unit_cost: c.unit_cost, sell_price: c.sell_price as number };
    }
  }
  throw new Error(`no free sellable line (qty >= ${minQty}) in seed`);
}
